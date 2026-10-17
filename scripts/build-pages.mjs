import {cp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {background} from '../lib.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'dist');
await rm(output,{recursive:true,force:true});
await cp(path.join(root,'public'),output,{recursive:true});
await mkdir(path.join(output,'assets'),{recursive:true});
for(const theme of ['violet','ocean','sunset'])await writeFile(path.join(output,'assets',`background-${theme}.png`),background(theme));
await writeFile(path.join(output,'config.js'),'window.KARAOKE_STATIC = true;\n');
const html=await readFile(path.join(output,'index.html'),'utf8');
await writeFile(path.join(output,'index.html'),html.replace('src="/api/background?theme=violet"','src="./assets/background-violet.png"'));
await writeFile(path.join(output,'.nojekyll'),'');
console.log('GitHub Pages build: dist/ (no credentials or server media included)');
