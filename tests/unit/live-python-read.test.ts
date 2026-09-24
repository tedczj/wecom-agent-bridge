import test from 'node:test';
import assert from 'node:assert/strict';
import { isPythonRead } from '../live/python-read.ts';

test('OFFLINE Python AST: literal byte checks, loops, formatting and assertions are analyzed without reading files', () => {
  const prefix = 'from pathlib import Path; expected={"nonexistent-one.txt":b"one\\n","two.txt":b"two\\n"}; ';
  for (const value of [
    '[(print(name, Path(name).read_bytes()==data)) for name,data in expected.items()]',
    '[(print(f"{name}: {len(want)} bytes, exact={Path(name).read_bytes()==want}")) for name,want in expected.items()]',
    '\nfor name,content in expected.items():\n actual=Path(name).read_bytes()\n assert actual==content,(name,actual)\n print(name)\n',
    'assert all(Path(name).read_bytes()==value for name,value in expected.items()); print("verified")',
    'print({name:Path(name).read_bytes()==value for name,value in expected.items()}); print(repr(Path("one.txt").read_bytes()))',
    '[(print(f"{name}: {len(data)} bytes" if (data := Path(name).read_bytes()) == value else "mismatch")) for name,value in expected.items()]',
  ]) assert.equal(isPythonRead(prefix + value), true, value);
  for (const value of ['import os; os.system("touch /tmp/unwanted")',
    'from pathlib import Path; Path("../outside").read_bytes()', 'from pathlib import Path; Path("one").write_bytes(b"x")',
    'from pathlib import Path; print(Path.__class__)', 'from pathlib import Path; print(Path("one").read_bytes.__call__())',
    'from pathlib import Path; Path=print; Path("one")', 'print(open("file").read())',
    prefix + '[(print(name)) for name,data in expected.items() if __import__("os")]',
    prefix + '\nfor name,data in expected.items():\n import socket\n',
    'print([x for x in range(100000000)])', 'while True: pass',
    'all=print; all("x")', 'repr=print; repr("x")',
    'from pathlib import Path; print((Path := "other"))',
  ]) assert.equal(isPythonRead(value), false, value);
});
