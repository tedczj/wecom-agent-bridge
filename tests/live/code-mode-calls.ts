import ts from 'typescript';

export interface ObservedCodeCall { tool: string; arguments: unknown }
/** Both parser rejection and the native pre-execution error are required; a runtime throw is insufficient. */
export function codeSyntaxRejected(source: string, output: unknown): boolean {
  if (source.length > 131072 || !Array.isArray(output) || output.length !== 2) return false;
  const rows = output as Array<{ type?: unknown; text?: unknown }>;
  if (rows.some(row => !row || row.type !== 'input_text' || typeof row.text !== 'string') ||
    !/^Script failed\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/.test(rows[0]!.text as string) ||
    !/^Script error:\nSyntaxError: [^\n]+$/.test(rows[1]!.text as string)) return false;
  return !!ts.transpileModule(source, { fileName: 'audit.js', compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true }).diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error && d.code >= 1000 && d.code < 2000);
}
const unknownResult = Symbol('tool-result');
type Value = string | number | boolean | null | typeof unknownResult | Value[] | { [key: string]: Value };

/** Parse a closed code-mode grammar without executing JavaScript. Extraction alone does not approve effects. */
export function extractCodeCalls(source: string): ObservedCodeCall[] | undefined {
  if (source.length > 131072) return;
  const calls: ObservedCodeCall[] = [], variables = new Map<string, Value>(); let visited = 0;
  const reject = (): never => { throw new Error('unsupported code'); };
  const data = (value: Value): boolean => value !== unknownResult && (Array.isArray(value) ? value.every(data) :
    value !== null && typeof value === 'object' ? Object.values(value).every(data) : true);
  // Display expressions may consume opaque results; they must never produce tool arguments.
  const display = (node: ts.Expression): void => {
    if (++visited > 10000) return reject();
    if (ts.isConditionalExpression(node)) {
      const condition = node.condition;
      if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !ts.isPropertyAccessExpression(condition.left) || condition.left.name.text !== 'status' || expression(condition.left) !== unknownResult ||
        !ts.isStringLiteral(condition.right) || condition.right.text !== 'fulfilled') return reject();
      display(node.whenTrue); display(node.whenFalse); return;
    }
    if (ts.isCallExpression(node) && !node.questionDotToken && !node.typeArguments && ts.isIdentifier(node.expression) && node.expression.text === 'String' && node.arguments.length === 1) {
      expression(node.arguments[0]!); return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          if (!ts.isIdentifier(property.expression) || variables.get(property.expression.text) !== unknownResult) return reject();
        } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) display(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer && variables.has(property.name.text)) continue;
        else return reject();
      }
    } else if (ts.isCallExpression(node) && !node.questionDotToken && !node.typeArguments && node.arguments.length === 1 &&
      ts.isPropertyAccessExpression(node.expression) && !node.expression.questionDotToken && ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'JSON' && node.expression.name.text === 'stringify') display(node.arguments[0]!);
    else expression(node);
  };
  const expression = (node: ts.Expression): Value => {
    if (++visited > 10000) return reject();
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) { const number = Number(node.text); return Number.isFinite(number) ? number : reject(); }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) return variables.has(node.text) ? variables.get(node.text)! : reject();
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return expression(node.expression);
    if (ts.isElementAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression) && ts.isIdentifier(node.argumentExpression)) {
      const values = variables.get(node.expression.text), index = variables.get(node.argumentExpression.text);
      if (!Array.isArray(values) || values.some(value => value !== unknownResult) || index !== 0) return reject();
      return unknownResult;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => expression(element));
    if (ts.isObjectLiteralExpression(node)) {
      const result: { [key: string]: Value } = Object.create(null);
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return reject();
        const name = property.name.text;
        if (['__proto__', 'prototype', 'constructor'].includes(name) || Object.hasOwn(result, name)) return reject();
        result[name] = expression(property.initializer);
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken && ['output', 'value', 'content', 'status', 'reason'].includes(node.name.text))
      return expression(node.expression) === unknownResult ? unknownResult : reject();
    if (!ts.isCallExpression(node) || node.questionDotToken || node.typeArguments || node.arguments.length !== 1) return reject();
    const target = node.expression;
    if (ts.isIdentifier(target) && target.text === 'text') { display(node.arguments[0]!); return null; }
    if (ts.isPropertyAccessExpression(target) && !target.questionDotToken && target.name.text === 'forEach' && ts.isIdentifier(target.expression)) {
      const values = variables.get(target.expression.text), callback = node.arguments[0]!;
      if (!Array.isArray(values) || values.some(value => value !== unknownResult) || !ts.isArrowFunction(callback) || callback.modifiers?.length ||
        callback.typeParameters || callback.type || callback.parameters.length < 1 || callback.parameters.length > 2 || ts.isBlock(callback.body)) return reject();
      const names = callback.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name) || parameter.type || parameter.initializer || parameter.dotDotDotToken || parameter.questionToken ||
          variables.has(parameter.name.text) || ['tools', 'text', 'Promise', 'JSON', 'String', 'exit'].includes(parameter.name.text)) return reject();
        return parameter.name.text;
      });
      if (new Set(names).size !== names.length || !ts.isCallExpression(callback.body) || !ts.isIdentifier(callback.body.expression) || callback.body.expression.text !== 'text') return reject();
      names.forEach((name, i) => variables.set(name, i === 0 ? unknownResult : 0));
      const count = calls.length; expression(callback.body); names.forEach(name => variables.delete(name));
      if (calls.length !== count) return reject();
      return null;
    }
    if (!ts.isPropertyAccessExpression(target) || target.questionDotToken || !ts.isIdentifier(target.expression)) return reject();
    if (target.expression.text === 'Promise' && ['all', 'allSettled'].includes(target.name.text)) {
      if (!ts.isArrayLiteralExpression(node.arguments[0]!)) return reject();
      return node.arguments[0].elements.map(element => expression(element));
    }
    if (target.expression.text !== 'tools' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(target.name.text)) return reject();
    const args = expression(node.arguments[0]!); if (!data(args) || calls.length >= 64) return reject();
    calls.push({ tool: target.name.text, arguments: args }); return unknownResult;
  };
  const declaration = (list: ts.VariableDeclarationList) => {
    if ((list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const || list.declarations.length !== 1) return reject();
    const value = list.declarations[0]!;
    if (!ts.isIdentifier(value.name) || ['tools', 'text', 'Promise', 'JSON', 'String', 'exit'].includes(value.name.text) || variables.has(value.name.text) || value.type || value.exclamationToken) return reject();
    return value;
  };
  try {
    if (ts.transpileModule(source, { reportDiagnostics: true }).diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) return;
    const file = ts.createSourceFile('calls.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement) && !statement.modifiers?.length) {
        const value = declaration(statement.declarationList); if (!value.initializer) return;
        variables.set((value.name as ts.Identifier).text, expression(value.initializer));
      } else if (ts.isExpressionStatement(statement)) expression(statement.expression);
      else if (ts.isForOfStatement(statement) && !statement.awaitModifier && ts.isVariableDeclarationList(statement.initializer)) {
        const value = declaration(statement.initializer), name = (value.name as ts.Identifier).text;
        if (value.initializer) return;
        const iterable = expression(statement.expression);
        if (!Array.isArray(iterable) || iterable.some(item => item !== unknownResult)) return;
        const body = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
        if (body.length !== 1 || !ts.isExpressionStatement(body[0]!) || !ts.isCallExpression(body[0].expression) ||
          !ts.isIdentifier(body[0].expression.expression) || body[0].expression.expression.text !== 'text') return;
        variables.set(name, unknownResult); const count = calls.length; expression(body[0].expression); variables.delete(name);
        if (count !== calls.length) return;
      } else if (ts.isForStatement(statement) && statement.initializer && ts.isVariableDeclarationList(statement.initializer) &&
        statement.condition && ts.isBinaryExpression(statement.condition) && statement.incrementor && ts.isPostfixUnaryExpression(statement.incrementor)) {
        const list = statement.initializer, variable = list.declarations[0], condition = statement.condition, increment = statement.incrementor;
        if ((list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Let || list.declarations.length !== 1 || !variable || !ts.isIdentifier(variable.name) ||
          variable.type || !variable.initializer || !ts.isNumericLiteral(variable.initializer) || variable.initializer.text !== '0' ||
          variables.has(variable.name.text) || ['tools', 'text', 'Promise', 'JSON', 'String', 'exit'].includes(variable.name.text) ||
          condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken || !ts.isIdentifier(condition.left) || condition.left.text !== variable.name.text ||
          !ts.isPropertyAccessExpression(condition.right) || condition.right.questionDotToken || condition.right.name.text !== 'length' || !ts.isIdentifier(condition.right.expression) ||
          increment.operator !== ts.SyntaxKind.PlusPlusToken || !ts.isIdentifier(increment.operand) || increment.operand.text !== variable.name.text) return;
        const values = variables.get(condition.right.expression.text), body = statement.statement;
        if (!Array.isArray(values) || values.some(value => value !== unknownResult) || !ts.isExpressionStatement(body) || !ts.isCallExpression(body.expression) ||
          !ts.isIdentifier(body.expression.expression) || body.expression.expression.text !== 'text') return;
        variables.set(variable.name.text, 0); const count = calls.length; expression(body.expression); variables.delete(variable.name.text);
        if (calls.length !== count) return;
      } else if (ts.isIfStatement(statement) && !statement.elseStatement && ts.isBinaryExpression(statement.expression)) {
        const condition = statement.expression, left = condition.left, right = condition.right, body = statement.thenStatement;
        // Enumerate later calls conservatively after the observed fail-fast guard; a missing native mirror still fails auditing.
        if (condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken || !ts.isPropertyAccessExpression(left) || left.questionDotToken ||
          left.name.text !== 'exit_code' || !ts.isIdentifier(left.expression) || variables.get(left.expression.text) !== unknownResult ||
          !ts.isNumericLiteral(right) || right.text !== '0' || !ts.isExpressionStatement(body) || !ts.isCallExpression(body.expression) ||
          !ts.isIdentifier(body.expression.expression) || body.expression.expression.text !== 'exit' || body.expression.arguments.length ||
          body.expression.questionDotToken || body.expression.typeArguments) return;
      } else return;
    }
    return calls;
  } catch { return; }
}
