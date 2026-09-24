import ts from 'typescript';

/** Recognize only a local ALL_TOOLS filter followed by text(result), never general JavaScript. */
export function isMetadataQuery(code: string): boolean {
  if (code.length > 4096 || ts.transpileModule(code, { reportDiagnostics: true }).diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) return false;
  const file = ts.createSourceFile('query.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.statements.length !== 2) return false;
  const [declaration, output] = file.statements;
  if (!declaration || !ts.isVariableStatement(declaration) || declaration.modifiers?.length ||
    (declaration.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const || declaration.declarationList.declarations.length !== 1) return false;
  const variable = declaration.declarationList.declarations[0]!;
  if (!ts.isIdentifier(variable.name) || ['text', 'ALL_TOOLS'].includes(variable.name.text) || variable.type || variable.exclamationToken) return false;
  const filter = variable.initializer;
  if (!filter || !ts.isCallExpression(filter) || filter.questionDotToken || filter.typeArguments || filter.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(filter.expression) || filter.expression.questionDotToken || filter.expression.name.text !== 'filter' ||
    !ts.isIdentifier(filter.expression.expression) || filter.expression.expression.text !== 'ALL_TOOLS') return false;
  const arrow = filter.arguments[0]!;
  if (!ts.isArrowFunction(arrow) || arrow.modifiers?.length || arrow.typeParameters || arrow.type || arrow.parameters.length !== 1) return false;
  const parameter = arrow.parameters[0]!;
  if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken || parameter.questionToken || parameter.type || parameter.modifiers?.length) return false;
  const name = parameter.name.text;
  const value = (node: ts.Node): boolean => ts.isStringLiteral(node) ||
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && value(node.left) && value(node.right) ||
    ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression) && node.expression.text === name && ['name', 'description'].includes(node.name.text);
  const predicate = arrow.body;
  if (!ts.isCallExpression(predicate) || predicate.questionDotToken || predicate.typeArguments || predicate.arguments.length !== 1 || !value(predicate.arguments[0]!) ||
    !ts.isPropertyAccessExpression(predicate.expression) || predicate.expression.questionDotToken || predicate.expression.name.text !== 'test' ||
    !ts.isRegularExpressionLiteral(predicate.expression.expression)) return false;
  if (!output || !ts.isExpressionStatement(output) || !ts.isCallExpression(output.expression)) return false;
  const call = output.expression;
  return !call.questionDotToken && !call.typeArguments && ts.isIdentifier(call.expression) && call.expression.text === 'text' &&
    call.arguments.length === 1 && ts.isIdentifier(call.arguments[0]!) && call.arguments[0].text === variable.name.text;
}
