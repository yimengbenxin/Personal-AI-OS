import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {dirname,relative,resolve,sep} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../../../../../',import.meta.url));
// These modules are imported by multiple independently installed packages.
// Contracts forbid all package imports. Shared runtime adapters permit erased types only.
const boundaries:{path:string;types:boolean;file?:boolean}[]=[
  {path:'capability/contracts',types:true},
  {path:'capability/sdk/ts',types:false},
  {path:'capability/packages/desktop/server',types:false},
  {path:'capability/packages/ts-host/result.ts',types:false,file:true},
  ...['ts-delivery','ts-erasure','ts-health','ts-location','ts-memory','ts-model-settings',
    'ts-personal','ts-personality','ts-schedule'].map(name=>({path:`capability/packages/${name}/server`,types:false})),
];
function sources(directory:string):string[]{
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=resolve(directory,entry.name);
    return entry.isDirectory()?sources(path):/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)?[path]:[];
  });
}

test('shared contracts and runtime adapters resolve without consumer package dependencies',()=>{
  const violations:string[]=[];
  for(const boundary of boundaries)for(const file of boundary.file?[resolve(root,boundary.path)]:sources(resolve(root,boundary.path))){
    const original=readFileSync(file,'utf8');
    const source=boundary.types?original:ts.transpileModule(original,{
      compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext},
    }).outputText;
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    const inspect=(specifier:ts.Node|undefined)=>{
      if(!specifier||!ts.isStringLiteralLike(specifier))return;
      const name=specifier.text;
      if(isBuiltin(name))return;
      const label=`${relative(root,file)} -> ${name}`;
      if(!name.startsWith('./')&&!name.startsWith('../')){violations.push(label);return;}
      const target=resolve(dirname(file),name);
      if(!boundaries.some(shared=>{
        const base=resolve(root,shared.path);
        return shared.file?target===base:target.startsWith(base+sep);
      }))violations.push(label+' (outside shared modules)');
    };
    const visit=(node:ts.Node)=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))inspect(node.moduleSpecifier);
      if(ts.isExternalModuleReference(node))inspect(node.expression);
      if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))inspect(node.argument.literal);
      if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||
        ts.isIdentifier(node.expression)&&node.expression.text==='require'))inspect(node.arguments[0]);
      ts.forEachChild(node,visit);
    };
    visit(ast);
  }
  assert.deepEqual(violations,[],'Keep installed dependencies in package-local wrappers.');
});
