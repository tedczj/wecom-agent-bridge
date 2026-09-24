declare module 'mvdan-sh' {
  interface Position { Offset(): number }
  interface Node {
    Pos(): Position; End(): Position;
    Stmts?: Node[]; Cmd?: Node; Background?: boolean; Coprocess?: boolean; Redirs?: Node[];
    Assigns?: Node[]; Args?: Node[]; Parts?: Node[]; Value?: string; Dollar?: boolean;
    Param?: Node; Op?: number; X?: Node; Y?: Node; Loop?: Node; Name?: Node; Items?: Node[];
    Do?: Node[]; Cond?: Node[]; Then?: Node[]; Else?: Node; Word?: Node; Hdoc?: Node; N?: Node; Select?: boolean;
  }
  const sh: { syntax: { NewParser(): { Parse(text: string, name: string): Node }; NodeType(node: Node): string } };
  export default sh;
  export type { Node };
}
