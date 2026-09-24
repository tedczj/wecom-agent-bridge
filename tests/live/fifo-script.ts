export type FifoScript = 'first-task' | 'second-task';
export function fifoScriptSource(name: FifoScript, token: string): string {
  return '#!/usr/bin/env node\n' + `const fs=require('node:fs'); const path=require('node:path'); const root=__dirname;
const record={pid:process.pid,token:${JSON.stringify(token)},script:fs.realpathSync(__filename),at:Date.now()};
fs.writeFileSync(path.join(root,${JSON.stringify('.' + name + '-started')}),JSON.stringify(record),{flag:'wx',mode:0o600});
${name === 'first-task' ? `const end=Date.now()+120000;
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'.first-release'))){clearInterval(timer);process.stdout.write('first-task completed\\n');}
else if(Date.now()>end){clearInterval(timer);process.exitCode=2;}},100);` : "process.stdout.write('second-task completed\\n');"}
`;
}
