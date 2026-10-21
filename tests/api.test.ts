import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { get as httpGet } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/database.ts';
import { createApp } from '../server/app.ts';
import { runDiagnostics } from '../server/domain.ts';
import { fixtureSales } from './fixture.ts';

test('API integra financeiro, importação, custos, operação e ciclo de decisão',async(t)=>{
  const s=new Store(':memory:'),server=createApp(s,{initialSales:fixtureSales}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.close();s.close();});const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function get(){const res=await fetch(origin+'/api/state?month=2026-10');assert.equal(res.status,200);return res.json();}
  async function post(path:string,body:unknown,key=crypto.randomUUID(),expected=200){const res=await fetch(origin+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});const result=await res.json();assert.equal(res.status,expected,JSON.stringify(result));return result;}
  let d=await get();assert.equal(d.financial.totals.gross_cents,928000);
  const receipt=d.financial.sales.find((s:any)=>s.contact_name==='Elisa').receipts[0];
  const correction={net_cents:67700,fee_cents:6300,received_on:null,reason:'Teste de integração'},operation=crypto.randomUUID();
  await post(`/receipts/${receipt.id}/correct`,correction,operation);await post(`/receipts/${receipt.id}/correct`,correction,operation);
  d=await get();assert.equal(d.financial.totals.receivable_cents,1000);assert.equal(d.financial.totals.received_cents,843100);
  const events=d.events.filter((e:any)=>e.entity_id===receipt.id);assert.equal(events.length,1);
  const sale={external_id:'api-fixture',contact_name:'Teste integração',sold_on:'2026-10-21',gross_cents:10000,payment_method:'Pix',net_received_cents:10000,items:[{service_name:'Botox',allocated_cents:10000}]};
  await post('/sales/import',{sales:[sale,{...sale,external_id:'invalid',gross_cents:-1}]},undefined,400);assert.equal((await get()).financial.sales.length,6);
  const imported=await post('/sales/import',{sales:[sale]});await post('/sales/import',{sales:[sale]});assert.equal((await get()).financial.sales.length,7);
  await post(`/sales/${imported.results[0].id}/refunds`,{amount_cents:1000,refunded_on:'2026-10-21',reason:'Teste de estorno'});
  await post('/expenses',{description:'Saída de teste',amount_cents:2000,category:'operational',due_on:'2026-10-21',paid_on:'2026-10-21'});
  await post('/settings',{key:'expenses_reviewed_month',value:'2026-09'});await post('/settings',{key:'expenses_reviewed_month',value:'2026-10'});assert.equal((await get()).financial.totals.expenses_reviewed,true);
  await post('/expenses',{description:'Nova saída de teste',amount_cents:100,category:'operational',due_on:'2026-10-21',paid_on:null});assert.equal((await get()).financial.totals.expenses_reviewed,false);assert.ok(s.get("SELECT expenses_reviewed_at FROM period_reviews WHERE month='2026-09'")!.expenses_reviewed_at);
  const product=await post('/products',{name:'Material API',unit:'unidade',unit_cost_cents:1000,effective_from:'2026-01-01'});
  await post('/stock/purchases',{product_id:product.id,quantity:5,unit_cost_cents:1000,occurred_on:'2026-10-21',paid_on:'2026-10-21',source:'Fixture'});
  const item=(await get()).financial.sales.find((r:any)=>r.id===imported.results[0].id).items[0];
  await post(`/sale-items/${item.id}/consume`,{performed_on:'2026-10-21',materials:[{product_id:product.id,quantity:1,unit_cost_cents:1000}],source:'Fixture',reason:'Consumo de teste'});
  d=await get();assert.equal(d.products.find((p:any)=>p.id===product.id).stock,4);assert.equal(d.financial.sales.find((r:any)=>r.id===imported.results[0].id).direct_cost_cents,1000);
  await post(`/products/${product.id}/cost`,{unit_cost_cents:2000,effective_from:'2026-10-22',source:'Nova vigência de teste'});assert.equal((await get()).financial.sales.find((r:any)=>r.id===imported.results[0].id).direct_cost_cents,1000);
  const campaign=await post('/campaigns',{name:'Campanha fixture',channel:'Manual',starts_on:'2026-10-01'});
  const opp=await post('/opportunities',{contact_name:'Contato novo',title:'Orçamento de teste',last_contact_on:'2026-10-01',campaign_id:campaign.id});
  const service=d.services.find((r:any)=>r.name==='Botox');
  const quote=await post('/quotes',{opportunity_id:opp.id,items:[{service_id:service.id,amount_cents:50000}]});
  await post(`/quotes/${quote.id}/accept`,{});d=await get();assert.equal(d.opportunities.find((o:any)=>o.id===opp.id).stage,'accepted');assert.equal(d.financial.sales.length,7);
  await post('/appointments',{contact_name:'Contato novo',service_id:service.id,starts_at:'2026-10-30T12:00:00-03:00',duration_minutes:60});
  await post('/appointments',{contact_name:'Outro contato',service_id:service.id,starts_at:'2026-10-30T12:30:00-03:00',duration_minutes:60},undefined,409);
  runDiagnostics(s);d=await get();const rec=d.recommendations.find((r:any)=>r.status==='open');const decision=await post(`/recommendations/${rec.id}/decide`,{choice:'accept',reason:'Teste'});
  await post(`/decisions/${decision.id}/outcome`,{executed_on:'2026-10-21',outcome:'Conferido no teste',outcome_on:'2026-10-21',learned:'Resultado informado, sem causalidade presumida'});
  assert.equal((await get()).decisions.find((r:any)=>r.id===decision.id).outcome,'Conferido no teste');
  const exp=await fetch(origin+'/api/export');assert.equal(exp.status,200);assert.ok((await exp.json()).data.events.length);
});

test('dados persistem entre reinicializações, e o seed não duplica registros',()=>{
  const dir=mkdtempSync(join(tmpdir(),'opora-db-test-')),path=join(dir,'db.sqlite');
  try{
    let s=new Store(path);createApp(s,{initialSales:fixtureSales});s.run("UPDATE receipts SET received_on='2026-10-21' WHERE rowid=1");const amount=s.get('SELECT SUM(net_cents) total FROM receipts')!.total;s.close();
    s=new Store(path);createApp(s);assert.equal(s.get('SELECT COUNT(*) n FROM sales')!.n,6);assert.equal(s.get('SELECT SUM(net_cents) total FROM receipts')!.total,amount);assert.equal(s.get('SELECT received_on FROM receipts WHERE rowid=1')!.received_on,'2026-10-21');s.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('controle de acesso, origem e host protegem os dados comerciais',async(t)=>{
  const previous=process.env.OPORA_ACCESS_PASSWORD;process.env.OPORA_ACCESS_PASSWORD='test-password-not-for-production';
  const s=new Store(':memory:'),server=createApp(s,{initialSales:fixtureSales}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.close();s.close();if(previous)process.env.OPORA_ACCESS_PASSWORD=previous;else delete process.env.OPORA_ACCESS_PASSWORD;});
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  assert.equal((await fetch(origin+'/api/state')).status,401);
  const badHost=await new Promise<number|undefined>((resolve,reject)=>{httpGet(origin+'/api/state',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(badHost,403);
  assert.equal((await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.invalid'},body:JSON.stringify({password:'test-password-not-for-production'})})).status,403);
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-password-not-for-production'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!;
  const res=await fetch(origin+'/api/state',{headers:{Cookie:cookie}});assert.equal(res.status,200);assert.equal((await res.json()).financial.sales.length,6);
});
