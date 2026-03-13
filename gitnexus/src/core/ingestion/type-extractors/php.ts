import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'assignment_expression', // For constructor inference: $x = new User()
]);

/** PHP: no typed local variable declarations */
const extractDeclaration: TypeBindingExtractor = (_node: SyntaxNode, _env: Map<string, string>): void => {
  // PHP has no typed local variable annotations; constructor inference is handled by extractInitializer
};

/** PHP: $x = new User() — infer type from object_creation_expression */
const extractInitializer: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type !== 'assignment_expression') return;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;
  if (right.type !== 'object_creation_expression') return;
  // The class name is the first named child of object_creation_expression
  // (tree-sitter-php uses 'name' or 'qualified_name' nodes here)
  const ctorType = right.firstNamedChild;
  if (!ctorType) return;
  const typeName = extractSimpleTypeName(ctorType);
  const varName = extractVarName(left);
  if (varName && typeName) env.set(varName, typeName);
};

/** PHP: simple_parameter → type $name */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'simple_parameter') {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
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
  extractParameter,
  extractInitializer,
};
