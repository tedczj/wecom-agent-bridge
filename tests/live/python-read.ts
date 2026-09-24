import { execFileSync } from 'node:child_process';

// Parse only. The supplied program is never imported, compiled or executed.
const analyzer = String.raw`
import ast, json, re, sys

def check(source):
 tree=ast.parse(source)
 if sum(1 for _ in ast.walk(tree))>1024: return False
 names={}
 def require(condition):
  if not condition: raise ValueError()
 def filename(value):
  return isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',value) is not None
 def expr(n):
  if isinstance(n,ast.Constant):
   require(type(n.value) in (str,bytes,int,bool) and len(str(n.value))<=20000)
   return (type(n.value).__name__,n.value)
  if isinstance(n,ast.Name):
   require(n.id in names); return names[n.id]
  if isinstance(n,ast.NamedExpr):
   require(isinstance(n.target,ast.Name) and n.target.id not in ('Path','print','len','all','repr'))
   value=expr(n.value); names[n.target.id]=value; return value
  if isinstance(n,(ast.Tuple,ast.List)):
   return ('sequence',[expr(x) for x in n.elts])
  if isinstance(n,ast.Dict):
   keys=[expr(x) for x in n.keys]; values=[expr(x) for x in n.values]
   require(0<len(keys)<=64 and all(k[0]=='str' and filename(k[1]) for k in keys) and all(v[0]=='bytes' for v in values))
   return ('dict',list(zip(keys,values)))
  if isinstance(n,ast.Compare):
   require(len(n.ops)==1 and isinstance(n.ops[0],ast.Eq) and expr(n.left)[0] in ('bytes','str','int','bool') and expr(n.comparators[0])[0] in ('bytes','str','int','bool'))
   return ('bool',None)
  if isinstance(n,ast.IfExp):
   require(expr(n.test)[0]=='bool'); expr(n.body); expr(n.orelse); return ('str',None)
  if isinstance(n,ast.JoinedStr):
   for x in n.values:
    if isinstance(x,ast.FormattedValue):
     expr(x.value); require(x.format_spec is None and x.conversion in (-1,115,114,97))
    else: require(isinstance(x,ast.Constant) and type(x.value) is str)
   return ('str',None)
  if isinstance(n,ast.Call):
   require(not n.keywords)
   if isinstance(n.func,ast.Name):
    name=n.func.id
    if name=='print':
     for a in n.args: expr(a)
     return ('none',None)
    if name=='len':
     require(len(n.args)==1 and expr(n.args[0])[0] in ('str','bytes','sequence')); return ('int',None)
    if name=='repr':
     require(len(n.args)==1 and expr(n.args[0])[0] in ('str','bytes','int','bool')); return ('str',None)
    if name=='all':
     require(len(n.args)==1); values=expr(n.args[0]); require(values[0]=='sequence' and all(x[0]=='bool' for x in values[1])); return ('bool',None)
    if name=='Path':
     require(names.get('Path')==('constructor',None) and len(n.args)==1)
     value=expr(n.args[0]); require(value[0]=='str' and filename(value[1])); return ('path',value[1])
   if isinstance(n.func,ast.Attribute) and not n.args:
    value=expr(n.func.value)
    if n.func.attr=='read_bytes' and value[0]=='path': return ('bytes',None)
    if n.func.attr=='items' and value[0]=='dict': return ('items',value[1])
   raise ValueError()
  if isinstance(n,(ast.ListComp,ast.GeneratorExp,ast.DictComp)):
   require(len(n.generators)==1); g=n.generators[0]; require(not g.ifs and not g.is_async)
   results=[]
   if isinstance(n,ast.DictComp):
    loop(g.target,g.iter,lambda:results.append((expr(n.key),expr(n.value)))); return ('display',None)
   loop(g.target,g.iter,lambda:results.append(expr(n.elt))); return ('sequence',results)
  raise ValueError()
 def loop(target,iterable,body):
  values=expr(iterable); require(values[0]=='items' and isinstance(target,ast.Tuple) and len(target.elts)==2)
  require(all(isinstance(x,ast.Name) and x.id not in ('Path','print','len','all','repr') for x in target.elts))
  a,b=(x.id for x in target.elts); require(a!=b)
  for key,value in values[1]:
   names[a]=key; names[b]=value; body()
 def statements(values):
  for n in values:
   if isinstance(n,ast.ImportFrom):
    require(n.module=='pathlib' and n.level==0 and len(n.names)==1 and n.names[0].name=='Path' and n.names[0].asname is None)
    names['Path']=('constructor',None)
   elif isinstance(n,ast.Assign):
    require(len(n.targets)==1 and isinstance(n.targets[0],ast.Name) and n.targets[0].id not in ('Path','print','len','all','repr'))
    names[n.targets[0].id]=expr(n.value)
   elif isinstance(n,ast.Expr): expr(n.value)
   elif isinstance(n,ast.Assert):
    require(expr(n.test)[0]=='bool')
    if n.msg: expr(n.msg)
   elif isinstance(n,ast.For):
    require(not n.orelse); loop(n.target,n.iter,lambda:statements(n.body))
   else: raise ValueError()
 statements(tree.body)
 return True
try: print(json.dumps(check(sys.stdin.read())))
except Exception: print('false')
`;

/** Bounded pathlib byte-read/print/assert grammar for synthetic fixture checks, using Python's standard AST parser. */
export function isPythonRead(source: string): boolean {
  if (!source || source.length > 16384 || source.includes('\0')) return false;
  try {
    return execFileSync('python3', ['-I', '-S', '-c', analyzer], { input: source, encoding: 'utf8', timeout: 2000, maxBuffer: 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] }).trim() === 'true';
  } catch { return false; }
}
