import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'let_declaration',
]);

/** Rust: let x: Foo = ... */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  const pattern = node.childForFieldName('pattern');
  const typeNode = node.childForFieldName('type');
  if (!pattern || !typeNode) return;
  const varName = extractVarName(pattern);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Rust: let x = User::new() or let x = User::default() */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, _classNames: ReadonlySet<string>): void => {
  const pattern = node.childForFieldName('pattern');
  const value = node.childForFieldName('value');
  if (!pattern || !value) return;
  if (value.type !== 'call_expression') return;
  const func = value.childForFieldName('function');
  if (!func || func.type !== 'scoped_identifier') return;
  const nameField = func.childForFieldName('name');
  // Only match ::new() and ::default() — the two idiomatic Rust constructors.
  // Deliberately excludes ::from(), ::with_capacity(), etc. to avoid false positives
  // (e.g. String::from("x") is not necessarily the "String" type we want for method resolution).
  if (!nameField || (nameField.text !== 'new' && nameField.text !== 'default')) return;
  const pathField = func.childForFieldName('path');
  if (!pathField) return;
  const typeName = extractSimpleTypeName(pathField);
  const varName = extractVarName(pattern);
  if (varName && typeName) env.set(varName, typeName);
};

/** Rust: parameter → pattern: type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  } else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractInitializer,
  extractParameter,
};
