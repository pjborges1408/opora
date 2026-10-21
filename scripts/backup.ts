import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const source=resolve(process.env.OPORA_DB??'.local/opora.sqlite');
if(!existsSync(source))throw new Error('Banco não encontrado. Inicie a aplicação antes do primeiro backup.');
const destination=resolve(process.argv[2]??`.local/backups/opora-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
if(existsSync(destination))throw new Error('O destino já existe. Escolha outro caminho; backups não são sobrescritos.');
mkdirSync(dirname(destination),{recursive:true,mode:0o700});
const db=new DatabaseSync(source,{readOnly:true});
try {await backup(db,destination);console.log('Backup consistente concluído. Guarde a cópia em armazenamento seguro.');}finally{db.close();}
