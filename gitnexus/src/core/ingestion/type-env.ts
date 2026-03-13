import type { SyntaxNode } from './utils.js';
import { FUNCTION_NODE_TYPES, extractFunctionName, CLASS_CONTAINER_TYPES } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { typeConfigs, TYPED_PARAMETER_TYPES } from './type-extractors/index.js';

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

/**
 * Look up a variable's type in the TypeEnv, trying the call's enclosing
 * function scope first, then falling back to file-level scope.
 */
export const lookupTypeEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
): string | undefined => {
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
 * Quick pre-scan: collect all class/struct names defined in this file's AST.
 * Used by extractInitializer to distinguish constructor calls from function calls
 * (e.g. C++ `auto x = User()` vs `auto x = getUser()`).
 */
const collectClassNames = (root: SyntaxNode): ReadonlySet<string> => {
  const names = new Set<string>();
  const walk = (node: SyntaxNode): void => {
    if (CLASS_CONTAINER_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) names.add(nameNode.text);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return names;
};

/**
 * Build a scoped TypeEnv from a tree-sitter AST for a given language.
 * Walks the tree tracking enclosing function scopes, so that variables
 * inside different functions don't collide.
 */
export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
): TypeEnv => {
  const env: TypeEnv = new Map();
  const classNames = collectClassNames(tree.rootNode);
  walkForTypes(tree.rootNode, language, env, FILE_SCOPE, classNames);
  return env;
};

const walkForTypes = (
  node: SyntaxNode,
  language: SupportedLanguages,
  env: TypeEnv,
  currentScope: string,
  classNames: ReadonlySet<string>,
): void => {
  // Detect scope boundaries (function/method definitions)
  let scope = currentScope;
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    const { funcName } = extractFunctionName(node);
    if (funcName) scope = `${funcName}@${node.startIndex}`;
  }

  // Get or create the sub-map for this scope
  if (!env.has(scope)) env.set(scope, new Map());
  const scopeEnv = env.get(scope)!;

  // Check if this node provides type information
  extractTypeBinding(node, language, scopeEnv, classNames);

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForTypes(child, language, env, scope, classNames);
  }
};

/**
 * Try to extract a (variableName → typeName) binding from a single AST node.
 * Delegates to per-language type configurations.
 *
 * Resolution tiers (first match wins):
 * - Tier 0: explicit type annotations via extractDeclaration
 * - Tier 1: constructor-call inference via extractInitializer (fallback)
 */
const extractTypeBinding = (
  node: SyntaxNode,
  language: SupportedLanguages,
  env: Map<string, string>,
  classNames: ReadonlySet<string>,
): void => {
  // === PARAMETERS (most languages) ===
  // This guard eliminates 90%+ of calls before any language dispatch.
  if (TYPED_PARAMETER_TYPES.has(node.type)) {
    const config = typeConfigs[language];
    config.extractParameter(node, env);
    return;
  }

  // === Per-language declaration extraction ===
  const config = typeConfigs[language];
  if (config.declarationNodeTypes.has(node.type)) {
    config.extractDeclaration(node, env);
    // Tier 1: constructor-call inference as fallback.
    // Always called when available — each language's extractInitializer
    // internally skips declarators that already have explicit annotations,
    // so this handles mixed cases like `const a: A = x, b = new B()`.
    if (config.extractInitializer) {
      config.extractInitializer(node, env, classNames);
    }
  }
};
