import type { SyntaxNode } from './utils.js';
import { FUNCTION_NODE_TYPES, extractFunctionName, CLASS_CONTAINER_TYPES } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { typeConfigs, TYPED_PARAMETER_TYPES } from './type-extractors/index.js';
import type { SymbolTable } from './symbol-table.js';

/**
 * Per-file scoped type environment: maps (scope, variableName) → typeName.
 * Scope-aware: variables inside functions are keyed by function name,
 * file-level variables use the '' (empty string) scope.
 *
 * Design constraints:
 * - Explicit-only: only type annotations, never inferred types
 * - Scope-aware: function-local variables don't collide across functions
 * - Conservative: complex/generic types extract the base name only
 * - Per-file: built once, used for receiver resolution, then discarded
 */
export type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key */
const FILE_SCOPE = '';

/** Fallback for languages where class names aren't in a 'name' field (e.g. Kotlin uses type_identifier). */
const findTypeIdentifierChild = (node: SyntaxNode): SyntaxNode | null => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'type_identifier') return child;
  }
  return null;
};

/**
 * Look up a variable's type in the TypeEnv, trying the call's enclosing
 * function scope first, then falling back to file-level scope.
 *
 * Special handling for `self`/`this`: resolves to the enclosing class name
 * by walking up the AST, enabling receiver-type filtering for self.method() calls.
 */
export const lookupTypeEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
): string | undefined => {
  // Self/this receiver: resolve to enclosing class name via AST walk
  if (varName === 'self' || varName === 'this') {
    return findEnclosingClassName(callNode);
  }

  // Determine the enclosing function scope for the call
  const scopeKey = findEnclosingScopeKey(callNode);

  // Try function-local scope first
  if (scopeKey) {
    const scopeEnv = env.get(scopeKey);
    if (scopeEnv) {
      const result = scopeEnv.get(varName);
      if (result) return result;
    }
  }

  // Fall back to file-level scope
  const fileEnv = env.get(FILE_SCOPE);
  return fileEnv?.get(varName);
};

/**
 * Walk up the AST from a node to find the enclosing class/module name.
 * Used to resolve `self`/`this` receivers to their containing type.
 */
const findEnclosingClassName = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
    current = current.parent;
  }
  return undefined;
};

/** Find the enclosing function name for scope lookup. */
const findEnclosingScopeKey = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName } = extractFunctionName(current);
      if (funcName) return `${funcName}@${current.startIndex}`;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Create a composite ReadonlySet that checks both local AST class names
 * AND the SymbolTable's global index. This allows extractInitializer functions
 * to distinguish constructor calls from function calls (e.g. Kotlin `User()` vs
 * `getUser()`) using cross-file type information when available.
 *
 * The SymbolTable doesn't support iteration, so we query it lazily via lookupFuzzy
 * — checking whether any definition of that name has type === 'Class'.
 */
const createClassNameLookup = (
  localNames: Set<string>,
  symbolTable?: SymbolTable,
): ReadonlySet<string> => {
  if (!symbolTable) return localNames;

  return {
    has(name: string): boolean {
      if (localNames.has(name)) return true;
      return symbolTable.lookupFuzzy(name).some(def => def.type === 'Class');
    },
    get size() { return localNames.size; },
    [Symbol.iterator]() { return localNames[Symbol.iterator](); },
    entries() { return localNames.entries(); },
    keys() { return localNames.keys(); },
    values() { return localNames.values(); },
    forEach(cb: (value: string, value2: string, set: ReadonlySet<string>) => void) {
      localNames.forEach(cb as any);
    },
  } as ReadonlySet<string>;
};

/**
 * Build a scoped TypeEnv from a tree-sitter AST for a given language.
 * Single-pass: collects class/struct names AND type bindings in one walk.
 * Class names are accumulated incrementally — this is safe because no
 * language allows constructing a class before its definition.
 *
 * When a symbolTable is provided (call-processor path), class names from across
 * the project are available for constructor inference in languages like Kotlin
 * where constructors are syntactically identical to function calls.
 */
export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
  symbolTable?: SymbolTable,
): TypeEnv => {
  const env: TypeEnv = new Map();
  const localClassNames = new Set<string>();
  const classNames = createClassNameLookup(localClassNames, symbolTable);
  const config = typeConfigs[language];

  /**
   * Try to extract a (variableName → typeName) binding from a single AST node.
   *
   * Resolution tiers (first match wins):
   * - Tier 0: explicit type annotations via extractDeclaration
   * - Tier 1: constructor-call inference via extractInitializer (fallback)
   */
  const extractTypeBinding = (node: SyntaxNode, scopeEnv: Map<string, string>): void => {
    // This guard eliminates 90%+ of calls before any language dispatch.
    if (TYPED_PARAMETER_TYPES.has(node.type)) {
      config.extractParameter(node, scopeEnv);
      return;
    }
    if (config.declarationNodeTypes.has(node.type)) {
      config.extractDeclaration(node, scopeEnv);
      // Tier 1: constructor-call inference as fallback.
      // Always called when available — each language's extractInitializer
      // internally skips declarators that already have explicit annotations,
      // so this handles mixed cases like `const a: A = x, b = new B()`.
      if (config.extractInitializer) {
        config.extractInitializer(node, scopeEnv, classNames);
      }
    }
  };

  const walk = (node: SyntaxNode, currentScope: string): void => {
    // Collect class/struct names as we encounter them (used by extractInitializer
    // to distinguish constructor calls from function calls, e.g. C++ `User()` vs `getUser()`)
    if (CLASS_CONTAINER_TYPES.has(node.type)) {
      // Most languages use 'name' field; Kotlin uses a type_identifier child instead
      const nameNode = node.childForFieldName('name')
        ?? findTypeIdentifierChild(node);
      if (nameNode) localClassNames.add(nameNode.text);
    }

    // Detect scope boundaries (function/method definitions)
    let scope = currentScope;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const { funcName } = extractFunctionName(node);
      if (funcName) scope = `${funcName}@${node.startIndex}`;
    }

    // Get or create the sub-map for this scope
    if (!env.has(scope)) env.set(scope, new Map());
    const scopeEnv = env.get(scope)!;

    extractTypeBinding(node, scopeEnv);

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, scope);
    }
  };

  walk(tree.rootNode, FILE_SCOPE);
  return env;
};

/**
 * Unverified constructor binding: a `val x = Callee()` pattern where we
 * couldn't confirm the callee is a class (because it's defined in another file).
 * The caller must verify `calleeName` against the SymbolTable before trusting.
 */
export interface ConstructorBinding {
  /** Function scope key (matches TypeEnv scope keys) */
  scope: string;
  /** Variable name that received the constructor result */
  varName: string;
  /** Name of the callee (potential class constructor) */
  calleeName: string;
}

/** C/C++: auto x = User() where function is an identifier (not type_identifier) */
const extractCppConstructorBinding = (node: SyntaxNode): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  const typeText = typeNode.text;
  if (typeText !== 'auto' && typeText !== 'decltype(auto)' && typeNode.type !== 'placeholder_type_specifier') return undefined;
  const declarator = node.childForFieldName('declarator');
  if (!declarator || declarator.type !== 'init_declarator') return undefined;
  const value = declarator.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;
  const func = value.childForFieldName('function');
  // Only match plain identifiers — type_identifier is already resolved by extractInitializer
  if (!func || func.type !== 'identifier') return undefined;
  const nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) return undefined;
  const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
    ? nameNode.firstNamedChild : nameNode;
  if (!finalName) return undefined;
  const varName = finalName.text;
  if (!varName) return undefined;
  return { varName, calleeName: func.text };
};

/** Ruby: user = User.new — assignment with call where method is 'new' and receiver is a constant */
const extractRubyConstructorBinding = (node: SyntaxNode): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'assignment') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'identifier') return undefined;
  if (right.type !== 'call') return undefined;
  const method = right.childForFieldName('method');
  if (!method || method.text !== 'new') return undefined;
  const receiver = right.childForFieldName('receiver');
  if (!receiver || receiver.type !== 'constant') return undefined;
  return { varName: left.text, calleeName: receiver.text };
};

/** Language-specific constructor-binding scanners. */
const CONSTRUCTOR_BINDING_SCANNERS: Partial<Record<SupportedLanguages, (node: SyntaxNode) => { varName: string; calleeName: string } | undefined>> = {
  // Kotlin: val x = User(...) — property_declaration with call_expression
  [SupportedLanguages.Kotlin]: (node) => {
    if (node.type !== 'property_declaration') return undefined;
    const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
    if (!varDecl) return undefined;
    if (varDecl.namedChildren.some(c => c.type === 'user_type')) return undefined;
    const callExpr = node.namedChildren.find(c => c.type === 'call_expression');
    if (!callExpr) return undefined;
    const callee = callExpr.firstNamedChild;
    if (!callee || callee.type !== 'simple_identifier') return undefined;
    const nameNode = varDecl.namedChildren.find(c => c.type === 'simple_identifier');
    if (!nameNode) return undefined;
    return { varName: nameNode.text, calleeName: callee.text };
  },

  // Python: user = User("alice") — assignment with call
  [SupportedLanguages.Python]: (node) => {
    if (node.type !== 'assignment') return undefined;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right) return undefined;
    // Skip annotated assignments — extractDeclaration handles those
    if (node.childForFieldName('type')) return undefined;
    if (left.type !== 'identifier') return undefined;
    if (right.type !== 'call') return undefined;
    const func = right.childForFieldName('function');
    if (!func || func.type !== 'identifier') return undefined;
    return { varName: left.text, calleeName: func.text };
  },

  // Swift: let user = User(name: "alice") — property_declaration with call_expression
  [SupportedLanguages.Swift]: (node) => {
    if (node.type !== 'property_declaration') return undefined;
    // Skip if has type annotation
    if (node.childForFieldName('type')) return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      if (node.namedChild(i)?.type === 'type_annotation') return undefined;
    }
    const pattern = node.childForFieldName('pattern');
    if (!pattern) return undefined;
    const varName = pattern.text;
    if (!varName) return undefined;
    // Find call_expression child
    let callExpr: SyntaxNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'call_expression') { callExpr = child; break; }
    }
    if (!callExpr) return undefined;
    const callee = callExpr.firstNamedChild;
    if (!callee || callee.type !== 'simple_identifier') return undefined;
    return { varName, calleeName: callee.text };
  },

  // C/C++: auto x = User() where User is parsed as identifier (cross-file)
  [SupportedLanguages.C]: extractCppConstructorBinding,
  [SupportedLanguages.CPlusPlus]: extractCppConstructorBinding,

  // Ruby: user = User.new — assignment with call where method is 'new' and receiver is a constant
  [SupportedLanguages.Ruby]: extractRubyConstructorBinding,
};

/**
 * Scan a file's AST for constructor-assignment patterns that couldn't be resolved
 * locally (callee not in the file's own class list). Returns unverified bindings
 * that must be checked against the SymbolTable before use.
 *
 * Called by the parse-worker to export candidates that processCallsFromExtracted
 * will verify and apply.
 */
export const scanConstructorBindings = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
  resolvedEnv: TypeEnv,
): ConstructorBinding[] => {
  const scanner = CONSTRUCTOR_BINDING_SCANNERS[language];
  if (!scanner) return [];

  const bindings: ConstructorBinding[] = [];

  const walk = (node: SyntaxNode, currentScope: string): void => {
    let scope = currentScope;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const { funcName } = extractFunctionName(node);
      if (funcName) scope = `${funcName}@${node.startIndex}`;
    }

    const result = scanner(node);
    if (result) {
      // Only collect if TypeEnv didn't already resolve this binding
      const scopeEnv = resolvedEnv.get(scope);
      if (!scopeEnv?.has(result.varName)) {
        bindings.push({ scope, ...result });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, scope);
    }
  };

  walk(tree.rootNode, FILE_SCOPE);
  return bindings;
};
