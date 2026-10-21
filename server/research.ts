import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { z } from 'zod';
import { Store, id, now, today } from './database.ts';
import { DomainError, text, fold, queue, requireRow, runDiagnostics, invalidate, idempotent } from './domain.ts';

const blocked = new BlockList();
for(const [network,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(network,prefix,'ipv4');
blocked.addSubnet('::',128,'ipv6');blocked.addSubnet('::1',128,'ipv6');blocked.addSubnet('fc00::',7,'ipv6');blocked.addSubnet('fe80::',10,'ipv6');blocked.addSubnet('ff00::',8,'ipv6');blocked.addSubnet('::ffff:0:0',96,'ipv6');
export function publicAddress(address:string) {
  return isIP(address)===4?!blocked.check(address,'ipv4'):isIP(address)===6?!blocked.check(address,'ipv6'):false;
}
export async function publicURL(raw:string) {
  let u:URL;try {u=new URL(raw);}catch {throw new DomainError('Informe uma URL válida.');}
  if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443'))throw new DomainError('Fontes externas devem usar HTTPS público, sem credenciais ou portas alternativas.');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(host==='localhost' || host.endsWith('.local') || host.endsWith('.internal'))throw new DomainError('Endereços internos não são permitidos.');
  // In cloud tasks DNS for an explicitly approved HTTPS host is resolved by the egress proxy.
  // Do not require direct container DNS, which may be unavailable on that supported route.
  const proxyEnabled=(process.execArgv.includes('--use-env-proxy') || process.env.NODE_USE_ENV_PROXY==='1') && !!(process.env.HTTPS_PROXY||process.env.https_proxy);
  if(!isIP(host) && proxyEnabled && sourceDomains().includes(host))return u;
  let addresses:{address:string}[];
  try {addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});}
  catch {throw new DomainError('O domínio da fonte não pôde ser resolvido. Confira o endereço e o acesso de rede.',502);}
  if(!addresses.length || addresses.some(a=>!publicAddress(a.address)))throw new DomainError('Endereços privados ou reservados não são fontes públicas.');
  return u;
}
export const sourceDomains=()=>['www.gov.br','gov.br','cfo.org.br','website.cfo.org.br','pubmed.ncbi.nlm.nih.gov','www.ncbi.nlm.nih.gov','developers.facebook.com','transparency.meta.com','sebrae.com.br','www.sebrae.com.br',...(process.env.OPORA_SOURCE_ALLOWED_DOMAINS??'').split(',').map(s=>s.trim()).filter(Boolean)];
export function assertPublicQuery(s:Store,input:string) {
  const q=fold(input);
  for(const c of s.all('SELECT name FROM contacts')) {
    const tokens=fold(c.name).split(/\s+/).filter((t:string)=>t.length>=3 && !['marido','esposa'].includes(t));
    if(tokens.some((t:string)=>new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z]|$)`).test(q))) {
      throw new DomainError('A consulta contém nome de um contato da clínica. Remova informações identificáveis antes de pesquisar.');
    }
  }
  if(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\d[\s().-]*){10,}/i.test(input))throw new DomainError('Remova telefones, documentos ou e-mails da consulta pública.');
}
export const researchSchema=z.object({question:text,purpose:text,region:text.default('Vitória/ES'),public_query_confirmed:z.literal(true)});
export function createResearch(s:Store,raw:unknown) {
  const v=researchSchema.parse(raw);assertPublicQuery(s,v.question+' '+v.purpose);
  const key=id();const configured=!!process.env.OPORA_SEARCH_API_KEY;
  s.run('INSERT INTO research VALUES(?,?,?,?,?,?,?,?)',key,v.question,v.purpose,v.region,configured?'pending':'blocked',configured?null:'Busca externa não configurada. Adicione OPORA_SEARCH_API_KEY nas configurações seguras do ambiente.',now(),now());
  if(configured)queue(s,'research','research:'+key,{research_id:key});
  s.event('research',key,configured?'Pesquisa enfileirada':'Pesquisa aguardando configuração',null,v);
  return {id:key,status:configured?'pending':'blocked'};
}
export function useBudget(s:Store,provider:string,limit:number) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new DomainError('O limite de chamadas deve ser um inteiro entre 1 e 10000. Nenhuma chamada foi feita.');
  const period=today().slice(0,7);
  s.transaction(()=>{
    const used=s.get('SELECT count FROM usage WHERE provider=? AND period=?',provider,period)?.count??0;
    if(used>=limit)throw new DomainError('Limite mensal de chamadas atingido. Nenhuma nova chamada foi feita.',429);
    s.run('INSERT INTO usage VALUES(?,?,1) ON CONFLICT(provider,period) DO UPDATE SET count=count+1',provider,period);
  });
}
export async function performResearch(s:Store,key:string,fetcher:typeof fetch=fetch) {
  const r=requireRow(s.get('SELECT * FROM research WHERE id=?',key));
  if(r.status==='completed')return;
  if(!process.env.OPORA_SEARCH_API_KEY) {
    s.run("UPDATE research SET status='blocked',error=?,updated_at=? WHERE id=?",'Busca externa não configurada. Nenhuma pesquisa foi realizada.',now(),key);
    throw new DomainError('Conector de busca não configurado.',424);
  }
  assertPublicQuery(s,r.question+' '+r.purpose);
  s.run("UPDATE research SET status='running',error=NULL,updated_at=? WHERE id=?",now(),key);
  useBudget(s,'search',Number(process.env.OPORA_SEARCH_MONTHLY_LIMIT??30));
  const url=new URL('https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',r.question+' '+r.region);url.searchParams.set('count','5');url.searchParams.set('country','BR');url.searchParams.set('search_lang','pt-br');
  const response=await fetcher(url,{headers:{'Accept':'application/json','X-Subscription-Token':process.env.OPORA_SEARCH_API_KEY},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new DomainError(`O provedor de busca respondeu HTTP ${response.status}. Nenhuma evidência foi inventada.`,[401,403].includes(response.status)?424:response.status===429?429:502);
  const data=z.object({web:z.object({results:z.array(z.object({title:z.string().max(2000),url:z.url(),description:z.string().max(10000).optional(),page_age:z.string().optional()})).max(20)}).optional()}).parse(await response.json());
  s.transaction(()=>{
    for(const source of data.web?.results??[]) {
      const u=new URL(source.url);if(u.protocol!=='https:')continue;
      // Search snippets are discovery evidence, not a claim that the source itself was read.
      const exists=s.get('SELECT id FROM evidence WHERE research_id=? AND url=?',key,source.url);if(exists)continue;
      const published=source.page_age?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]??null;
      s.run('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)',id(),key,source.title,source.url,source.description??'Sem trecho disponível.',now(),published,r.region,'Trecho retornado pelo buscador; página de origem não verificada. Não comprova demanda local, preço vigente nem causalidade.','observed',1);
    }
    s.run("UPDATE research SET status='completed',error=NULL,updated_at=? WHERE id=?",now(),key);
    s.event('research',key,'Pesquisa concluída com resposta real do conector',null,{sources:data.web?.results?.length??0},['Fontes salvas; nenhuma conclusão automática sobre a clínica']);
  });
}
export async function addURLSource(s:Store,raw:unknown,fetcher:typeof fetch=fetch,requestKey?:string) {
  const v=z.object({url:z.url(),purpose:text,region:text.default('Vitória/ES'),public_query_confirmed:z.literal(true)}).parse(raw);
  assertPublicQuery(s,v.url+' '+v.purpose);
  const url=await publicURL(v.url);
  if(!sourceDomains().includes(url.hostname))throw new DomainError('Domínio não habilitado para leitura direta. Adicione o hostname a OPORA_SOURCE_ALLOWED_DOMAINS no servidor e à política de rede do ambiente.');
  // No redirects: prevents a public URL from redirecting to a private endpoint.
  let response:Response;
  try {response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'Accept':'text/html,text/plain'}});}
  catch {throw new DomainError('Não foi possível acessar a fonte por HTTPS. Confira a permissão do domínio na rede, a disponibilidade da fonte e a configuração de confiança TLS. Nenhuma evidência foi criada.',502);}
  if(!response.ok)throw new DomainError(`A fonte respondeu HTTP ${response.status}. O conteúdo não foi importado.`,502);
  const type=response.headers.get('content-type')??'';
  if(!/text\/(html|plain)/i.test(type))throw new DomainError('Apenas páginas HTML ou texto são aceitas como fontes.');
  const reader=response.body?.getReader();let body='';let bytes=0;const decoder=new TextDecoder();
  if(!reader)throw new DomainError('A fonte não retornou conteúdo.');
  try { while(true) {const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1_000_000)throw new DomainError('A fonte ultrapassou o limite de 1 MB.');body+=decoder.decode(part.value,{stream:true});} }
  finally {await reader.cancel();}
  const title=body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g,'').trim()??url.hostname;
  const plain=body.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().slice(0,8000);
  if(plain.length<30)throw new DomainError('A página não forneceu texto legível suficiente. Pode depender de JavaScript ou login.');
  const commit=()=>{
    const existing=s.get('SELECT e.* FROM evidence e JOIN research r ON r.id=e.research_id WHERE e.url=? AND r.purpose=? ORDER BY consulted_at DESC LIMIT 1',url.toString(),v.purpose);
    if(existing) {
      const changed=existing.excerpt!==plain || existing.title!==title.slice(0,2000);
      s.run('UPDATE evidence SET excerpt=?,title=?,consulted_at=?,version=version+? WHERE id=?',plain,title.slice(0,2000),now(),changed?1:0,existing.id);
      const impacts=changed?invalidate(s,'evidence',existing.id):[];
      s.event('evidence',existing.id,changed?'Fonte consultada novamente com alteração de conteúdo':'Fonte conferida sem alteração de conteúdo',existing,{excerpt:plain,title,consulted_at:now()},impacts);
      return {id:existing.id,duplicate:!changed,refreshed:true};
    }
    const researchId=id(),evidenceId=id();
    s.run('INSERT INTO research VALUES(?,?,?,?,?,?,?,?)',researchId,'Consultar fonte: '+url.hostname,v.purpose,v.region,'completed',null,now(),now());
    s.run('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)',evidenceId,researchId,title.slice(0,2000),url.toString(),plain,now(),null,v.region,'Página consultada por URL; data de publicação não verificada. Conteúdo externo não confiável; não comprova demanda local.','observed',1);
    s.event('evidence',evidenceId,'Fonte pública consultada por URL',null,{url:url.toString(),purpose:v.purpose});
    return {id:evidenceId};
  };
  return requestKey?idempotent(s,requestKey,{path:'/evidence/url',body:raw},commit):s.transaction(commit);
}

export function startWorker(s:Store) {
  let busy=false;
  async function tick() {
    if(busy)return;busy=true;
    try {
      const schedules=s.all('SELECT * FROM research_schedules WHERE enabled=1 AND next_run_at<=?',now());
      for(const schedule of schedules) s.transaction(()=>{
        createResearch(s,{...schedule,public_query_confirmed:true});
        s.run('UPDATE research_schedules SET next_run_at=? WHERE id=?',new Date(Date.now()+schedule.interval_hours*3600000).toISOString(),schedule.id);
      });
      const job=s.get("SELECT * FROM jobs WHERE status='pending' AND available_at<=? ORDER BY created_at LIMIT 1",now());
      if(!job)return;
      s.run("UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?",now(),job.id);
      try {
        if(job.type==='diagnostics')runDiagnostics(s);
        else if(job.type==='research')await performResearch(s,JSON.parse(job.payload_json).research_id);
        else throw new DomainError('Tipo de tarefa não suportado.');
        s.run("UPDATE jobs SET status='completed',error=NULL,updated_at=? WHERE id=?",now(),job.id);
      } catch(error) {
        const blocked=error instanceof DomainError && error.status===424;
        const attempts=job.attempts+1;const retry=!blocked && attempts<job.max_attempts && !(error instanceof DomainError && [400,401,403,429].includes(error.status));
        const message=error instanceof DomainError?error.message:'Falha de rede ou resposta inválida do provedor. Nenhuma evidência foi inventada.';
        s.run('UPDATE jobs SET status=?,error=?,available_at=?,updated_at=? WHERE id=?',blocked?'blocked':retry?'pending':'error',message,new Date(Date.now()+attempts*30000).toISOString(),now(),job.id);
        if(job.type==='research')s.run('UPDATE research SET status=?,error=?,updated_at=? WHERE id=?',blocked?'blocked':retry?'pending':'error',message,now(),JSON.parse(job.payload_json).research_id);
      }
    } finally {busy=false;}
  }
  const timer=setInterval(()=>{void tick().catch(()=>console.error('Falha no worker; consulte os estados das tarefas.'));},1500);
  timer.unref();void tick();return ()=>clearInterval(timer);
}
