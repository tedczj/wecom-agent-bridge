import sh, { type Node } from 'mvdan-sh';

export interface ShellCommand { argv: string[]; stdin?: string; stdout?: string }
const syntax = sh.syntax;
const binaryOperators = new Set(['a && b', 'a || b', 'a | b', 'a |& b'].map(text => syntax.NewParser().Parse(text, 'operator.sh').Stmts![0]!.Cmd!.Op));
const heredocOperator = syntax.NewParser().Parse("a <<'EOF'\nx\nEOF\n", 'operator.sh').Stmts![0]!.Redirs![0]!.Op;
const descriptorOperator = syntax.NewParser().Parse('a 2>&1', 'operator.sh').Stmts![0]!.Redirs![0]!.Op;
const outputOperator = syntax.NewParser().Parse('a > file', 'operator.sh').Stmts![0]!.Redirs![0]!.Op;

/** Enumerate possible calls in bounded literal/loop control flow. This is not execution or effect approval. */
export function shellCommands(source: string): ShellCommand[] | undefined {
  if (source.length > 131072 || source.includes('\0')) return;
  const commands: ShellCommand[] = [], bindings = new Map<string, string>(), bytes = Buffer.from(source); let nodes = 0;
  const reject = (): never => { throw new Error('unsupported shell'); };
  const raw = (node: Node) => bytes.subarray(node.Pos().Offset(), node.End().Offset()).toString('utf8');
  const quotedLiteral = (value: string): string => {
    let result = '';
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '\\' && ['\\', '"', '$', '`', '\n'].includes(value[i + 1] ?? '')) {
        if (value[++i] !== '\n') result += value[i];
      } else result += value[i];
    }
    return result;
  };
  const word = (node: Node): string => {
    if (++nodes > 10000) return reject();
    return (node.Parts ?? []).map(part => {
      switch (syntax.NodeType(part)) {
        case 'Lit': if ((part.Value ?? '').startsWith('~') || !['[', ']'].includes(part.Value ?? '') && /[\\*?\[\]{}]/.test(part.Value ?? '')) return reject(); return part.Value ?? '';
        case 'SglQuoted': if (part.Dollar) return reject(); return part.Value ?? '';
        case 'DblQuoted':
          if (part.Dollar || part.Parts?.some(child => syntax.NodeType(child) === 'ParamExp') && part.Parts.length !== 1) return reject();
          return (part.Parts ?? []).map(child => {
            if (syntax.NodeType(child) === 'Lit') return quotedLiteral(child.Value ?? '');
            if (syntax.NodeType(child) === 'ParamExp') {
              const name = child.Param?.Value, text = raw(child);
              if (name && bindings.has(name) && [String('$' + name), '${' + name + '}'].includes(text)) return bindings.get(name)!;
            }
            return reject();
          }).join('');
        default: return reject();
      }
    }).join('');
  };
  const statements = (values: Node[] = []) => { for (const value of values) statement(value); };
  const condition = (node: Node) => { statements(node.Cond); statements(node.Then); if (node.Else) condition(node.Else); };
  const statement = (node: Node): void => {
    if (++nodes > 10000 || commands.length >= 256 || node.Background || node.Coprocess || !node.Cmd) return reject();
    const cmd = node.Cmd, type = syntax.NodeType(cmd);
    if (type !== 'CallExpr' && node.Redirs?.length) return reject();
    if (type === 'CallExpr') {
      if (cmd.Assigns?.length || !cmd.Args?.length) return reject();
      const call: ShellCommand = { argv: cmd.Args.map(word) };
      for (const redirect of node.Redirs ?? []) {
        if (redirect.Op === descriptorOperator && ['2>&1', '1>&2'].includes(raw(redirect))) continue;
        if (redirect.Op === outputOperator && !redirect.N && !redirect.Hdoc && redirect.Word && call.stdout === undefined) { call.stdout = word(redirect.Word); continue; }
        if (call.stdin !== undefined || redirect.Op !== heredocOperator || redirect.N || !redirect.Word || !redirect.Hdoc ||
          redirect.Word.Parts?.length !== 1 || syntax.NodeType(redirect.Word.Parts[0]!) !== 'SglQuoted' || redirect.Word.Parts[0]!.Dollar ||
          redirect.Hdoc.Parts?.some(part => syntax.NodeType(part) !== 'Lit')) return reject();
        call.stdin = (redirect.Hdoc.Parts ?? []).map(part => part.Value ?? '').join('');
      }
      commands.push(call);
    } else if (type === 'BinaryCmd' && binaryOperators.has(cmd.Op) && cmd.X && cmd.Y) {
      statement(cmd.X); statement(cmd.Y);
    } else if (type === 'IfClause') condition(cmd);
    else if (type === 'ForClause' && !cmd.Select && cmd.Loop && syntax.NodeType(cmd.Loop) === 'WordIter') {
      const name = cmd.Loop.Name?.Value, items = cmd.Loop.Items;
      if (!name || bindings.has(name) || !items?.length || items.length > 64) return reject();
      const values = items.map(word);
      for (const value of values) { bindings.set(name, value); statements(cmd.Do); }
      bindings.delete(name);
    } else return reject();
  };
  try { statements(syntax.NewParser().Parse(source, 'audit.sh').Stmts); return commands; } catch { return; }
}
