import ts from 'typescript';

const commands = new Set(["rg --files -g 'README*' -g '!node_modules'", "rg --files -g 'README*'", "rg --files -g 'README*' -g 'AGENTS.md'",
  "rg -n '^# ' README.md", "rg -n '^#{1,6} ' README.md"]);
/** Closed grammar for the observed README reads, not a general JavaScript or shell safety checker. */
export function readCommand(code: string, expectedCwd?: string): string | undefined {
  if (code.length > 4096 || ts.transpileModule(code, { reportDiagnostics: true }).diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) return;
  const file = ts.createSourceFile('read.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.statements.length !== 2) return;
  const [declaration, output] = file.statements;
  if (!declaration || !ts.isVariableStatement(declaration) || declaration.modifiers?.length ||
    (declaration.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const || declaration.declarationList.declarations.length !== 1) return;
  const variable = declaration.declarationList.declarations[0]!;
  if (!ts.isIdentifier(variable.name) || ['tools', 'text'].includes(variable.name.text) || variable.type || variable.exclamationToken || !variable.initializer || !ts.isAwaitExpression(variable.initializer)) return;
  const call = variable.initializer.expression;
  if (!ts.isCallExpression(call) || call.questionDotToken || call.typeArguments || call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken || call.expression.name.text !== 'exec_command' ||
    !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'tools' || !ts.isObjectLiteralExpression(call.arguments[0]!)) return;
  let command: string | undefined; const keys = new Set<string>();
  for (const field of call.arguments[0].properties) {
    if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name) && !ts.isStringLiteral(field.name)) return;
    const key = field.name.text; if (keys.has(key)) return; keys.add(key);
    if (key === 'cmd') {
      if (!ts.isStringLiteral(field.initializer) || !commands.has(field.initializer.text)) return;
      command = field.initializer.text;
    } else if (key === 'workdir') {
      if (!expectedCwd || !ts.isStringLiteral(field.initializer) || field.initializer.text !== expectedCwd) return;
    } else if (key === 'max_output_tokens') {
      if (!ts.isNumericLiteral(field.initializer) || !Number.isSafeInteger(Number(field.initializer.text)) || Number(field.initializer.text) < 1 || Number(field.initializer.text) > 4096) return;
    } else return;
  }
  if (!output || !ts.isExpressionStatement(output) || !ts.isCallExpression(output.expression)) return;
  const printed = output.expression;
  if (printed.questionDotToken || printed.typeArguments || !ts.isIdentifier(printed.expression) || printed.expression.text !== 'text' || printed.arguments.length !== 1) return;
  const value = printed.arguments[0]!;
  if (!ts.isPropertyAccessExpression(value) || value.questionDotToken || value.name.text !== 'output' || !ts.isIdentifier(value.expression) || value.expression.text !== variable.name.text) return;
  return command;
}
