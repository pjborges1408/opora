import express, { type Request, type Response } from 'express';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store, id, now, today } from './database.ts';
import { DomainError, requireRow, text, date, money, seed, financial, listSales, importSaleInTransaction, idempotent, addProduct, changeCost, addSimulation, recalculateSimulation, correctReceipt, depend, invalidate, queue, decide, recordOutcome, reviseEvidence, contact, service } from './domain.ts';
import { createResearch, addURLSource, researchSchema, sourceDomains } from './research.ts';
import { propose, confirmProposal, acceptQuote, addReceipt } from './assistant.ts';

export function state(s:Store,month:string) {
  return {
    today:today(),financial:financial(s,month),
    contacts:s.all('SELECT * FROM contacts ORDER BY name'),services:s.all('SELECT * FROM services ORDER BY name'),
    products:s.all('SELECT * FROM products').map(p=>({...p,costs:s.all('SELECT * FROM product_costs WHERE product_id=? ORDER BY effective_from DESC',p.id),stock:s.get('SELECT SUM(quantity) quantity FROM stock_movements WHERE product_id=?',p.id)!.quantity})),
    materials:s.all('SELECT m.*,p.name product_name,p.unit FROM service_materials m JOIN products p ON p.id=m.product_id'),
    simulations:s.all('SELECT v.*,p.name service_name FROM simulations v JOIN services p ON p.id=v.service_id ORDER BY v.updated_at DESC'),
    recommendations:s.all('SELECT * FROM recommendations ORDER BY stale DESC,created_at').map(r=>({...r,evidence:JSON.parse(r.evidence_json)})),
    decisions:s.all('SELECT d.*,r.title,r.uncertainty FROM decisions d JOIN recommendations r ON r.id=d.recommendation_id ORDER BY d.created_at DESC').map(d=>({...d,snapshot:JSON.parse(d.snapshot_json)})),
    research:s.all('SELECT * FROM research ORDER BY created_at DESC LIMIT 100'),evidence:s.all('SELECT * FROM evidence ORDER BY consulted_at DESC LIMIT 100'),
    schedules:s.all('SELECT * FROM research_schedules'),jobs:s.all('SELECT id,type,status,attempts,error,updated_at FROM jobs ORDER BY updated_at DESC LIMIT 30'),
    events:s.all('SELECT * FROM events ORDER BY seq DESC LIMIT 100').map(e=>({...e,impacts:JSON.parse(e.impacts_json)})),
    dependencies:s.all('SELECT * FROM dependencies'),settings:Object.fromEntries(s.all('SELECT * FROM settings').map(x=>[x.key,x.value])),
    opportunities:s.all('SELECT o.*,c.name contact_name,cam.name campaign_name FROM opportunities o JOIN contacts c ON c.id=o.contact_id LEFT JOIN campaigns cam ON cam.id=o.campaign_id ORDER BY updated_at DESC'),
    quotes:s.all('SELECT q.*,o.title FROM quotes q JOIN opportunities o ON o.id=q.opportunity_id'),
    campaigns:s.all('SELECT * FROM campaigns ORDER BY updated_at DESC'),
    appointments:s.all('SELECT a.*,c.name contact_name,p.name service_name FROM appointments a JOIN contacts c ON c.id=a.contact_id JOIN services p ON p.id=a.service_id ORDER BY starts_at'),
    integrations:{search:!!process.env.OPORA_SEARCH_API_KEY,ai:process.env.OPORA_ENABLE_AI==='1'&&!!process.env.OPORA_AI_API_KEY,source_domains:sourceDomains(),whatsapp:false,instagram:false,ads:false,calendar:false,worker:'Worker no processo servidor; não depende da página aberta. Pausa se o servidor parar.',deployment:'Instância local de desenvolvimento; não publicada.'},
    usage:s.all('SELECT * FROM usage WHERE period=?',today().slice(0,7))
  };
}
export function createApp(s:Store,{initialize=true,initialSales}:{initialize?:boolean;initialSales?:unknown[]}={}) {
  if(initialize)seed(s,initialSales);
  const app=express();app.disable('x-powered-by');app.use(express.json({limit:'1mb'}));
  const allowedHosts=new Set(['localhost','127.0.0.1','::1']);
  if(process.env.OPORA_PUBLIC_ORIGIN)allowedHosts.add(new URL(process.env.OPORA_PUBLIC_ORIGIN).hostname);
  app.use((req,res,next)=>allowedHosts.has(req.hostname.replace(/^\[|\]$/g,''))?next():res.status(403).json({error:'Host não autorizado.'}));
  app.use((_req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});next();
  });
  const sessions=new Map<string,number>(),attempts=new Map<string,{n:number,until:number}>();
  app.get('/api/health',(_req,res)=>res.json({ok:true,database:!!s.get('SELECT 1 ok'),version:'0.1.0'}));
  app.use('/api',(req,res,next)=>{
    if(req.method!=='GET' && req.headers.origin) {
      const allowed=new Set([`http://${req.headers.host}`,`https://${req.headers.host}`,process.env.OPORA_PUBLIC_ORIGIN??'']);
      if(!allowed.has(req.headers.origin))return res.status(403).json({error:'Origem da solicitação não autorizada.'});
    }
    next();
  });
  app.get('/api/auth', (req,res)=>res.json({required:!!process.env.OPORA_ACCESS_PASSWORD,authenticated:authorized(req)}));
  function authorized(req:Request) {
    if(!process.env.OPORA_ACCESS_PASSWORD)return true;
    const token=req.headers.cookie?.match(/(?:^|;\s*)opora_session=([a-f0-9]+)/)?.[1];
    return !!token && (sessions.get(token)??0)>Date.now();
  }
  app.post('/api/login',(req,res)=>{
    const ip=req.socket.remoteAddress??'unknown';const prior=attempts.get(ip);
    if(prior && prior.until>Date.now() && prior.n>=5)return res.status(429).json({error:'Muitas tentativas. Tente novamente em 15 minutos.'});
    if(!process.env.OPORA_ACCESS_PASSWORD)return res.status(400).json({error:'Acesso local não exige login.'});
    const password=z.object({password:z.string().max(1000)}).parse(req.body).password;
    const digest=(x:string)=>createHash('sha256').update(x).digest();
    if(!timingSafeEqual(digest(password),digest(process.env.OPORA_ACCESS_PASSWORD))) {
      attempts.set(ip,{n:prior&&prior.until>Date.now()?prior.n+1:1,until:Date.now()+900000});
      return res.status(401).json({error:'Senha incorreta.'});
    }
    attempts.delete(ip);for(const [key,expires] of sessions)if(expires<Date.now())sessions.delete(key);
    const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+43200000);
    res.cookie('opora_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.OPORA_PUBLIC_ORIGIN?.startsWith('https://')??false,maxAge:43200000});res.json({ok:true});
  });
  app.use('/api',(req,res,next)=>authorized(req)?next():res.status(401).json({error:'Entre para acessar os dados da clínica.'}));
  app.post('/api/logout',(req,res)=>{const token=req.headers.cookie?.match(/opora_session=([a-f0-9]+)/)?.[1];if(token)sessions.delete(token);res.clearCookie('opora_session');res.json({ok:true});});
  const mutate=(path:string,fn:(req:Request)=>unknown)=>app.post(path,(req,res)=>res.json(idempotent(s,req.get('Idempotency-Key'),{path:req.path,body:req.body},()=>fn(req))));
  app.get('/api/state',(req,res)=>{const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.query.month??today().slice(0,7));res.json(state(s,month));});
  app.get('/api/export',(_req,res)=>{
    const tables=['contacts','services','sales','sale_items','receipts','refunds','products','product_costs','service_materials','expenses','stock_movements','opportunities','quotes','quote_items','appointments','campaigns','settings','period_reviews','simulations','research','evidence','recommendations','decisions','dependencies','events','research_schedules'];
    res.set('Content-Disposition','attachment; filename="opora-export.json"');res.json({exported_at:now(),version:1,data:Object.fromEntries(tables.map(t=>[t,s.all(`SELECT * FROM ${t}`)]))});
  });
  mutate('/api/sales/import',req=>{
    const rows=z.array(z.unknown()).min(1).max(500).parse(req.body.sales);return {results:rows.map(v=>importSaleInTransaction(s,v))};
  });
  mutate('/api/receipts/:id/correct',req=>correctReceipt(s,String(req.params.id),req.body));
  mutate('/api/sales/:id/receipts',req=>addReceipt(s,String(req.params.id),req.body));
  mutate('/api/sales/:id/allocate',req=>{
    const sale=requireRow(s.get('SELECT * FROM sales WHERE id=?',String(req.params.id)));
    const v=z.object({items:z.array(z.object({id:text,allocated_cents:money,service_name:text})).min(1),reason:text}).parse(req.body);
    const before=s.all('SELECT * FROM sale_items WHERE sale_id=?',sale.id);
    if(v.items.length!==before.length || new Set(v.items.map(i=>i.id)).size!==before.length || v.items.some(i=>!before.some(b=>b.id===i.id)) || v.items.reduce((a,i)=>a+i.allocated_cents,0)!==sale.gross_cents-sale.discount_cents)throw new DomainError('Divida o valor total da venda entre todos os itens, sem duplicar itens.');
    for(const item of v.items)s.run('UPDATE sale_items SET allocated_cents=?,service_id=? WHERE id=?',item.allocated_cents,service(s,item.service_name),item.id);
    invalidate(s,'sales',sale.id);s.event('sales',sale.id,'Divisão dos itens confirmada: '+v.reason,before,v,['Receita por procedimento recalculada']);return {ok:true};
  });
  mutate('/api/sale-items/:id/cost',req=>{
    const v=z.object({direct_cost_cents:money,performed_on:date,source:text,reason:text}).parse(req.body);
    const before=requireRow(s.get('SELECT * FROM sale_items WHERE id=?',String(req.params.id)));
    if(v.performed_on>today())throw new DomainError('A realização deve ser confirmada com uma data passada ou de hoje.');
    s.run('UPDATE sale_items SET direct_cost_cents=?,performed_on=?,cost_source=? WHERE id=?',v.direct_cost_cents,v.performed_on,v.source,before.id);
    invalidate(s,'sales',before.sale_id);s.event('sale_items',before.id,'Custo efetivo e realização confirmados: '+v.reason,before,v,['Histórico de correção preservado','Resultado gerencial recalculado']);return {ok:true};
  });
  mutate('/api/sales/:id/refunds',req=>{
    const v=z.object({amount_cents:money.positive(),refunded_on:date,reason:text}).parse(req.body);const sale=requireRow(s.get('SELECT * FROM sales WHERE id=?',String(req.params.id)));
    const received=s.get('SELECT COALESCE(SUM(net_cents),0) total FROM receipts WHERE sale_id=?',sale.id)!.total;
    const refunded=s.get('SELECT COALESCE(SUM(amount_cents),0) total FROM refunds WHERE sale_id=?',sale.id)!.total;
    if(v.amount_cents+refunded>received)throw new DomainError('O estorno não pode exceder o que foi efetivamente recebido.');
    const key=id();s.run('INSERT INTO refunds VALUES(?,?,?,?,?,?)',key,sale.id,v.amount_cents,v.refunded_on,v.reason,'Informado pela profissional');invalidate(s,'sales',sale.id);s.event('refunds',key,'Estorno confirmado',null,v,['Caixa atualizado; a venda original permanece no histórico']);return {id:key};
  });
  mutate('/api/products',req=>addProduct(s,req.body));
  mutate('/api/products/:id/cost',req=>changeCost(s,String(req.params.id),req.body));
  mutate('/api/materials',req=>{
    const v=z.object({service_id:text,product_id:text,quantity:z.number().positive().max(100000)}).parse(req.body);
    requireRow(s.get('SELECT * FROM services WHERE id=?',v.service_id));requireRow(s.get('SELECT * FROM products WHERE id=?',v.product_id));
    s.run('INSERT INTO service_materials VALUES(?,?,?) ON CONFLICT(service_id,product_id) DO UPDATE SET quantity=excluded.quantity',v.service_id,v.product_id,v.quantity);
    for(const sim of s.all('SELECT * FROM simulations WHERE service_id=?',v.service_id))recalculateSimulation(s,sim.id);
    s.event('service_materials',v.service_id,'Consumo padrão atualizado',null,v,['Simulações futuras recalculadas','Consumos históricos preservados']);return {ok:true};
  });
  mutate('/api/simulations',req=>addSimulation(s,req.body));
  mutate('/api/expenses',req=>{
    const v=z.object({description:text,amount_cents:money.positive(),category:z.enum(['operational','investment','tax','transfer','withdrawal','inventory']),due_on:date,paid_on:date.nullable().default(null),source:text.default('Informado pela profissional')}).parse(req.body);
    s.run('UPDATE period_reviews SET expenses_reviewed_at=NULL WHERE month=?',v.due_on.slice(0,7));const key=id();s.run('INSERT INTO expenses VALUES(?,?,?,?,?,?,?)',key,v.description,v.amount_cents,v.category,v.due_on,v.paid_on,v.source);invalidate(s,'expenses',key);s.event('expenses',key,'Saída registrada',null,v,['Fluxo de caixa e resultado recalculados conforme categoria']);return {id:key};
  });
  mutate('/api/expenses/:id/pay',req=>{
    const v=z.object({paid_on:date,reason:text}).parse(req.body),r=requireRow(s.get('SELECT * FROM expenses WHERE id=?',String(req.params.id)));
    s.run('UPDATE expenses SET paid_on=? WHERE id=?',v.paid_on,r.id);s.event('expenses',r.id,'Pagamento confirmado: '+v.reason,r,v,['Fluxo de caixa atualizado; sem duplicar despesa']);return {ok:true};
  });
  mutate('/api/stock/purchases',req=>{
    const v=z.object({product_id:text,quantity:z.number().positive(),unit_cost_cents:money,occurred_on:date,paid_on:date.nullable(),source:text}).parse(req.body);
    const p=requireRow(s.get('SELECT * FROM products WHERE id=?',v.product_id)),key=id(),expense=id();
    s.run('INSERT INTO expenses VALUES(?,?,?,?,?,?,?)',expense,'Compra de estoque: '+p.name,Math.round(v.quantity*v.unit_cost_cents),'inventory',v.occurred_on,v.paid_on,v.source);
    s.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?)',key,p.id,v.quantity,v.unit_cost_cents,v.occurred_on,expense,null,v.source);
    s.event('stock_movements',key,'Compra e entrada de estoque registradas',null,v,['Compra afeta caixa quando paga; custo direto somente no consumo']);return {id:key};
  });
  mutate('/api/sale-items/:id/consume',req=>{
    const v=z.object({performed_on:date,materials:z.array(z.object({product_id:text,quantity:z.number().positive(),unit_cost_cents:money})).min(1),source:text,reason:text}).parse(req.body);
    if(v.performed_on>today())throw new DomainError('Consumo efetivo exige realização até hoje.');
    const item=requireRow(s.get('SELECT * FROM sale_items WHERE id=?',String(req.params.id)));
    if(item.direct_cost_cents!==null)throw new DomainError('O custo já foi informado. Use correção explícita do custo para preservar a trilha de auditoria.',409);
    let total=0;for(const m of v.materials){requireRow(s.get('SELECT * FROM products WHERE id=?',m.product_id));total+=Math.round(m.quantity*m.unit_cost_cents);s.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?)',id(),m.product_id,-m.quantity,m.unit_cost_cents,v.performed_on,null,item.id,v.source);}
    s.run('UPDATE sale_items SET direct_cost_cents=?,performed_on=?,cost_source=? WHERE id=?',total,v.performed_on,v.source,item.id);
    invalidate(s,'sales',item.sale_id);s.event('sale_items',item.id,'Consumo efetivo registrado: '+v.reason,item,{...v,total_cents:total},['Custo histórico fixado','Estoque e resultado atualizados']);return {ok:true,total_cents:total};
  });
  mutate('/api/settings',req=>{
    const v=z.object({key:z.enum(['weekly_available_hours','monthly_goal_cents','preferences','expenses_reviewed_month']),value:text}).parse(req.body);
    if(v.key==='weekly_available_hours' && (!Number.isFinite(Number(v.value)) || Number(v.value)<0 || Number(v.value)>168))throw new DomainError('Disponibilidade deve ficar entre 0 e 168 horas por semana.');
    if(v.key==='monthly_goal_cents' && (!Number.isSafeInteger(Number(v.value))||Number(v.value)<0))throw new DomainError('Meta inválida.');
    if(v.key==='expenses_reviewed_month'&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.value))throw new DomainError('Mês inválido.');
    if(v.key==='expenses_reviewed_month')s.run('INSERT INTO period_reviews VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET expenses_reviewed_at=excluded.expenses_reviewed_at,source=excluded.source',v.value,now(),'Conferência explícita da profissional');
    const before=s.get('SELECT * FROM settings WHERE key=?',v.key);s.run('INSERT INTO settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',v.key,v.value,now());
    invalidate(s,'settings',v.key);s.event('settings',v.key,'Preferência ou contexto atualizado',before,v,['Capacidade e contexto serão usados nas próximas revisões']);return {ok:true};
  });
  mutate('/api/research',req=>createResearch(s,req.body));
  app.post('/api/evidence/url',async(req,res)=>{
    const key=req.get('Idempotency-Key');if(!key||key.length>150)throw new DomainError('Envie Idempotency-Key de até 150 caracteres.');
    // Persist result and evidence atomically; retries reuse the same operation.
    const prior=s.get('SELECT * FROM requests WHERE request_key=?',key);
    if(prior)return res.json(idempotent(s,key,{path:'/evidence/url',body:req.body},()=>null));
    res.json(await addURLSource(s,req.body,fetch,key));
  });
  mutate('/api/research/schedules/:id/toggle',req=>{
    const v=z.object({enabled:z.boolean()}).parse(req.body),r=requireRow(s.get('SELECT * FROM research_schedules WHERE id=?',String(req.params.id)));
    s.run('UPDATE research_schedules SET enabled=? WHERE id=?',v.enabled?1:0,r.id);s.event('research_schedules',r.id,v.enabled?'Recorrência reativada':'Recorrência pausada',r,v);return {ok:true};
  });
  mutate('/api/research/:id/retry',req=>{
    const r=requireRow(s.get('SELECT * FROM research WHERE id=?',String(req.params.id)));if(r.status==='completed')throw new DomainError('Pesquisa já concluída. Crie uma nova para atualizar as fontes.');
    if(!process.env.OPORA_SEARCH_API_KEY)throw new DomainError('Configure primeiro OPORA_SEARCH_API_KEY no servidor.',424);
    s.run("UPDATE research SET status='pending',error=NULL,updated_at=? WHERE id=?",now(),r.id);queue(s,'research','research:'+r.id,{research_id:r.id});return {ok:true};
  });
  mutate('/api/research/schedules',req=>{
    const v=researchSchema.extend({interval_hours:z.number().int().min(24).max(8760)}).parse(req.body);
    if(!process.env.OPORA_SEARCH_API_KEY)throw new DomainError('Conecte a busca antes de agendar pesquisas recorrentes.',424);
    createResearch(s,v);const key=id();s.run('INSERT INTO research_schedules VALUES(?,?,?,?,?,?,?)',key,v.question,v.purpose,v.region,v.interval_hours,new Date(Date.now()+v.interval_hours*3600000).toISOString(),1);
    s.event('research_schedules',key,'Pesquisa recorrente autorizada',null,v);return {id:key};
  });
  mutate('/api/evidence/:id/revise',req=>reviseEvidence(s,String(req.params.id),req.body));
  mutate('/api/recommendations',req=>{
    const v=z.object({title:text,finding:text,action:text,evidence_ids:z.array(text).min(1),why:text,effort:text,impact:text,assumptions:text,uncertainty:text,reevaluate_when:text}).parse(req.body);
    for(const key of v.evidence_ids)requireRow(s.get('SELECT * FROM evidence WHERE id=?',key));
    const key=id();s.run('INSERT INTO recommendations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,null,v.title,'Hipótese informada: '+v.finding,JSON.stringify(v.evidence_ids.map(e=>({type:'evidence',id:e}))),v.why,v.action,v.effort,v.impact,v.assumptions,v.uncertainty,v.reevaluate_when,'open',0,now(),now());
    for(const e of v.evidence_ids)depend(s,'evidence',e,'recommendations',key);
    s.event('recommendations',key,'Hipótese criada a partir de evidências',null,v);return {id:key};
  });
  mutate('/api/recommendations/:id/review',req=>{
    const v=z.object({finding:text,reason:text}).parse(req.body),r=requireRow(s.get('SELECT * FROM recommendations WHERE id=?',String(req.params.id)));
    if(r.rule_key) {queue(s,'diagnostics','diagnostics',{});return {queued:true};}
    s.run('UPDATE recommendations SET finding=?,stale=0,updated_at=? WHERE id=?',v.finding,now(),r.id);s.event('recommendations',r.id,'Recomendação revisada: '+v.reason,r,v);return {ok:true};
  });
  mutate('/api/recommendations/:id/decide',req=>decide(s,String(req.params.id),req.body));
  mutate('/api/decisions/:id/outcome',req=>recordOutcome(s,String(req.params.id),req.body));
  mutate('/api/opportunities',req=>{
    const v=z.object({contact_name:text,title:text,last_contact_on:date,campaign_id:text.nullable().default(null)}).parse(req.body);
    if(v.campaign_id)requireRow(s.get('SELECT * FROM campaigns WHERE id=?',v.campaign_id));
    const key=id();s.run('INSERT INTO opportunities VALUES(?,?,?,?,?,?,?,?)',key,contact(s,v.contact_name,'Informado pela profissional'),v.campaign_id,v.title,'new',v.last_contact_on,'Informado pela profissional',now());
    invalidate(s,'opportunities',key);s.event('opportunities',key,'Oportunidade registrada',null,v);return {id:key};
  });
  mutate('/api/opportunities/:id/update',req=>{
    const v=z.object({stage:z.enum(['new','proposal','accepted','lost']),last_contact_on:date,note:text}).parse(req.body),r=requireRow(s.get('SELECT * FROM opportunities WHERE id=?',String(req.params.id)));
    s.run('UPDATE opportunities SET stage=?,last_contact_on=?,updated_at=? WHERE id=?',v.stage,v.last_contact_on,now(),r.id);invalidate(s,'opportunities',r.id);s.event('opportunities',r.id,'Acompanhamento: '+v.note,r,v);return {ok:true};
  });
  mutate('/api/quotes',req=>{
    const v=z.object({opportunity_id:text,items:z.array(z.object({service_id:text,amount_cents:money.positive()})).min(1)}).parse(req.body);
    requireRow(s.get('SELECT * FROM opportunities WHERE id=?',v.opportunity_id));for(const i of v.items)requireRow(s.get('SELECT * FROM services WHERE id=?',i.service_id));
    const key=id();s.run('INSERT INTO quotes VALUES(?,?,?,?,?)',key,v.opportunity_id,v.items.reduce((a,i)=>a+i.amount_cents,0),'draft',now());
    for(const i of v.items)s.run('INSERT INTO quote_items VALUES(?,?,?,?)',id(),key,i.service_id,i.amount_cents);
    s.run("UPDATE opportunities SET stage='proposal',updated_at=? WHERE id=?",now(),v.opportunity_id);invalidate(s,'opportunities',v.opportunity_id);s.event('quotes',key,'Orçamento preparado',null,v);return {id:key};
  });
  mutate('/api/quotes/:id/accept',req=>acceptQuote(s,String(req.params.id)));
  mutate('/api/appointments',req=>{
    const v=z.object({contact_name:text,service_id:text,starts_at:z.iso.datetime({offset:true}),duration_minutes:z.number().int().positive().max(1440)}).parse(req.body);
    requireRow(s.get('SELECT * FROM services WHERE id=?',v.service_id));
    const overlaps=s.all("SELECT * FROM appointments WHERE status='scheduled'").some(a=>new Date(v.starts_at).getTime()<new Date(a.starts_at).getTime()+a.duration_minutes*60000 && new Date(a.starts_at).getTime()<new Date(v.starts_at).getTime()+v.duration_minutes*60000);
    if(overlaps)throw new DomainError('Já existe um atendimento nesse intervalo.',409);
    const key=id();s.run('INSERT INTO appointments VALUES(?,?,?,?,?,?,?,?)',key,contact(s,v.contact_name,'Informado pela profissional'),v.service_id,v.starts_at,v.duration_minutes,'scheduled',null,'Informado pela profissional');
    invalidate(s,'appointments',key);s.event('appointments',key,'Agendamento registrado',null,v,['Agenda local atualizada; nenhuma mensagem enviada']);return {id:key};
  });
  mutate('/api/campaigns',req=>{
    const v=z.object({name:text,channel:text,spend_cents:money.nullable().default(null),starts_on:date}).parse(req.body);const key=id();s.run('INSERT INTO campaigns VALUES(?,?,?,?,?,?,?)',key,v.name,v.channel,v.spend_cents,v.starts_on,'Informado pela profissional',now());invalidate(s,'campaigns',key);s.event('campaigns',key,'Campanha registrada',null,v,['Sem atribuição causal ou custo por aquisição sem dados suficientes']);return {id:key};
  });
  app.post('/api/assistant/propose',async(req,res)=>res.json(await propose(s,req.body)));
  mutate('/api/assistant/:id/confirm',req=>confirmProposal(s,String(req.params.id)));
  const dist=resolve('dist');if(existsSync(dist)) {app.use(express.static(dist,{etag:true}));app.get('/{*path}',(req,res,next)=>req.path.startsWith('/api/')?next():res.sendFile(resolve(dist,'index.html')));}
  app.use('/api',(_req,res)=>res.status(404).json({error:'Operação não encontrada.'}));
  app.use((error:unknown,_req:Request,res:Response,_next:unknown)=>{
    if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')});
    if(error instanceof DomainError)return res.status(error.status).json({error:error.message});
    if(error instanceof SyntaxError)return res.status(400).json({error:'JSON inválido ou resposta externa ilegível. Nenhuma alteração foi confirmada.'});
    console.error('Falha interna:',error instanceof Error?error.message:'erro desconhecido');return res.status(500).json({error:'Não foi possível concluir. A operação local foi revertida; confira o histórico antes de tentar novamente.'});
  });
  return app;
}
