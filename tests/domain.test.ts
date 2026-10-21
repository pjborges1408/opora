import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, id, now } from '../server/database.ts';
import { addProduct, addSimulation, allocateFees, changeCost, correctReceipt, decide, depend, financial, idempotent, importSale, importSaleInTransaction, listSales, recordOutcome, reviseEvidence, seed, runDiagnostics } from '../server/domain.ts';
import { createResearch, performResearch, publicAddress, publicURL, assertPublicQuery } from '../server/research.ts';
import { confirmProposal, localInterpret, propose } from '../server/assistant.ts';
import { fixtureSales } from './fixture.ts';

const fresh=()=>{const s=new Store(':memory:');seed(s,fixtureSales);return s;};
test('concilia os seis registros confirmados sem inventar datas, custos ou lucro',()=>{
  const s=fresh();try{
    const f=financial(s,'2026-10');assert.equal(f.sales.length,6);
    assert.equal(f.totals.gross_cents,928000);assert.equal(f.totals.fee_cents,83900);assert.equal(f.totals.after_fees_cents,844100);assert.equal(f.totals.received_cents,844100);
    assert.equal(f.totals.receivable_cents,0);assert.equal(f.totals.result_cents,null);assert.equal(f.totals.undated_received_cents,844100);assert.equal(f.totals.cash_in_cents,0);
    assert.ok(f.sales.every(v=>v.receipts.every((r:any)=>r.received_on===null)));assert.ok(f.sales.every(v=>v.direct_cost_cents===null));
    seed(s);assert.equal(listSales(s).length,6);
  }finally{s.close();}
});
test('reimportar usa referência estável e rejeita conflitos; parcelas não criam vendas',()=>{
  const s=fresh();try{
    const row={external_id:'test-sale',contact_name:'Contato de teste',sold_on:'2026-10-22',gross_cents:10000,payment_method:'Cartão',installments:10,net_received_cents:9000,fee_cents:1000,items:[{service_name:'Botox',allocated_cents:10000}]};
    const first=importSale(s,row);const second=importSale(s,row);assert.equal(first.id,second.id);assert.equal(second.duplicate,true);assert.equal(listSales(s).length,7);
    assert.throws(()=>importSale(s,{...row,gross_cents:11000,items:[{service_name:'Botox',allocated_cents:11000}]}),/já existe/);assert.equal(listSales(s).length,7);
    assert.throws(()=>importSale(s,{...row,external_id:'changed-ref'}),/mesmo contato/);assert.equal(listSales(s).length,7);
  }finally{s.close();}
});
test('combos sem divisão não geram receita individual fictícia',()=>{
  const s=fresh();try{
    const f=financial(s,'2026-10');assert.equal(f.by_service.find(p=>p.name==='Botox')!.known_sold_cents,170000);assert.equal(f.by_service.find(p=>p.name==='Bioestimulador')!.known_sold_cents,153000);
    assert.equal(f.by_service.find(p=>p.name==='Preenchimento labial')!.known_sold_cents,0);assert.equal(f.totals.allocation_pending_sales,3);
    assert.equal(f.sales.find(v=>v.contact_name==='Cecilia')!.items.every((i:any)=>i.allocated_cents===null),true);
  }finally{s.close();}
});
test('corrigir recebimento atualiza recebido, saldo, caixa e histórico sem alterar vendido',()=>{
  const s=fresh();try{
    const sale=listSales(s).find(v=>v.contact_name==='Alex')!,receipt=sale.receipts[0];
    correctReceipt(s,receipt.id,{net_cents:132500,fee_cents:10500,received_on:'2026-10-03',reason:'Extrato conferido'});
    const f=financial(s,'2026-10');assert.equal(f.totals.gross_cents,928000);assert.equal(f.totals.received_cents,834100);assert.equal(f.totals.receivable_cents,10000);assert.equal(f.totals.cash_in_cents,132500);
    const event=s.get("SELECT * FROM events WHERE entity_type='receipts' ORDER BY seq DESC LIMIT 1")!;assert.equal(JSON.parse(event.before_json).net_cents,142500);assert.equal(JSON.parse(event.after_json).net_cents,132500);
    assert.ok(s.get("SELECT * FROM recommendations WHERE rule_key='undated-receipts'")!.stale);
  }finally{s.close();}
});
test('nova vigência recalcula simulações futuras e preserva custos históricos',()=>{
  const s=fresh();try{
    const p=addProduct(s,{name:'Material teste',unit:'unidade',unit_cost_cents:10000,effective_from:'2026-01-01'});
    const service=s.get("SELECT id FROM services WHERE name='Botox'")!;
    s.run('INSERT INTO service_materials VALUES(?,?,?)',service.id,p.id,1.5);
    const sim=addSimulation(s,{service_id:service.id,price_cents:100000,as_of:'2026-11-01'}),old=addSimulation(s,{service_id:service.id,price_cents:100000,as_of:'2026-09-01'});
    const item=s.get('SELECT * FROM sale_items WHERE service_id=? LIMIT 1',service.id)!;s.run('UPDATE sale_items SET direct_cost_cents=15000 WHERE id=?',item.id);
    assert.equal(s.get('SELECT * FROM simulations WHERE id=?',sim.id)!.margin_cents,85000);
    changeCost(s,p.id,{unit_cost_cents:20000,effective_from:'2026-10-21',source:'Nova nota'});
    assert.equal(s.get('SELECT * FROM simulations WHERE id=?',sim.id)!.cost_cents,30000);assert.equal(s.get('SELECT * FROM simulations WHERE id=?',old.id)!.cost_cents,15000);assert.equal(s.get('SELECT * FROM sale_items WHERE id=?',item.id)!.direct_cost_cents,15000);
    assert.equal(s.all('SELECT * FROM product_costs WHERE product_id=?',p.id).length,2);
    assert.throws(()=>changeCost(s,p.id,{unit_cost_cents:999,effective_from:'2026-10-21',source:'Tentativa de sobrescrever'}),/vigência/);
  }finally{s.close();}
});
test('simulação sem materiais deixa custo e margem desconhecidos',()=>{
  const s=fresh();try{const service=s.get('SELECT * FROM services LIMIT 1')!,v=addSimulation(s,{service_id:service.id,price_cents:50000,as_of:'2026-10-21'});const sim=s.get('SELECT * FROM simulations WHERE id=?',v.id)!;assert.equal(sim.cost_cents,null);assert.equal(sim.margin_cents,null);assert.ok(JSON.parse(sim.missing_costs).length);}finally{s.close();}
});
test('evidência corrigida invalida recomendação dependente e bloqueia decisão desatualizada',()=>{
  const s=fresh();try{
    const evidence=id(),recommendation=s.get('SELECT * FROM recommendations LIMIT 1')!;
    s.run('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)',evidence,null,'Fonte de teste','https://example.com','Trecho inicial de teste',now(),null,'Teste','Fixture de teste; sem pesquisa real','informed',1);
    depend(s,'evidence',evidence,'recommendations',recommendation.id);
    reviseEvidence(s,evidence,{excerpt:'Trecho corrigido de teste',limitations:'Ainda incerto',reason:'Correção da fixture'});
    assert.equal(s.get('SELECT * FROM recommendations WHERE id=?',recommendation.id)!.stale,1);assert.equal(s.get('SELECT version FROM evidence WHERE id=?',evidence)!.version,2);
    assert.throws(()=>decide(s,recommendation.id,{choice:'accept'}),/desatualizada/);
    assert.throws(()=>depend(s,'recommendations',recommendation.id,'evidence',evidence),/circular/);
  }finally{s.close();}
});
test('sugestão percorre decisão, execução, resultado e aprendizado corrigível',()=>{
  const s=fresh();try{
    const r=s.get('SELECT * FROM recommendations LIMIT 1')!,d=decide(s,r.id,{choice:'adjust',reason:'Cabe no meu ritmo',action:'Conferir dois atendimentos',review_on:'2026-10-30'});
    recordOutcome(s,d.id,{executed_on:'2026-10-22',outcome:'Dois custos foram conferidos',outcome_on:'2026-10-23',learned:'Falta conferir outros itens. Não é prova de melhora da margem.'});
    assert.equal(s.get('SELECT * FROM decisions WHERE id=?',d.id)!.executed_on,'2026-10-22');assert.ok(s.get('SELECT * FROM decisions WHERE id=?',d.id)!.learned.includes('Não é prova'));
    const snapshot=JSON.parse(s.get('SELECT * FROM decisions WHERE id=?',d.id)!.snapshot_json);s.run('UPDATE recommendations SET finding=? WHERE id=?','Entendimento posterior',r.id);assert.notEqual(snapshot.recommendation.finding,'Entendimento posterior');assert.ok(snapshot.evidence.length);
    assert.equal(s.all("SELECT * FROM settings WHERE key='preferences'").length,0);
  }finally{s.close();}
});
test('rateio das taxas conserva os centavos e não presume divisão de combo',()=>{
  const allocation=allocateFees([{id:'a',allocated_cents:3333},{id:'b',allocated_cents:3333},{id:'c',allocated_cents:3334}],101);
  assert.equal([...allocation.values()].reduce((a:number,v)=>a+(v??0),0),101);assert.equal(allocation.get('c'),34);
  assert.equal(allocateFees([{id:'a',allocated_cents:null}],101).get('a'),null);
});
test('idempotência é atômica: falhas revertem dados e retries não duplicam',()=>{
  const s=fresh();try{
    const before=s.get('SELECT COUNT(*) n FROM contacts')!.n;
    assert.throws(()=>idempotent(s,'fail',{},()=>{s.run('INSERT INTO contacts VALUES(?,?,?,?)',id(),'Fixture','Teste',now());throw new Error('falha simulada');}));
    assert.equal(s.get('SELECT COUNT(*) n FROM contacts')!.n,before);assert.equal(s.get("SELECT * FROM requests WHERE request_key='fail'"),undefined);
    let calls=0;const fn=()=>{calls++;return addProduct(s,{name:'Teste atômico',unit:'ml',unit_cost_cents:100,effective_from:'2026-10-21'});};
    const first=idempotent(s,'ok',{a:1},fn),again=idempotent(s,'ok',{a:1},fn);assert.deepEqual(first,again);assert.equal(calls,1);assert.throws(()=>idempotent(s,'ok',{a:2},fn),/outro conteúdo/);
  }finally{s.close();}
});
test('conector sem chave falha explicitamente; nenhuma evidência é fabricada',async()=>{
  const prior=process.env.OPORA_SEARCH_API_KEY;delete process.env.OPORA_SEARCH_API_KEY;
  const s=fresh();try{
    const r=createResearch(s,{question:'Regras públicas de anúncios',purpose:'Conferir campanha',public_query_confirmed:true});assert.equal(r.status,'blocked');
    await assert.rejects(()=>performResearch(s,r.id),/não configurado/);assert.equal(s.all('SELECT * FROM evidence').length,0);
    assert.throws(()=>assertPublicQuery(s,'O que Daniela quer?'),/nome de um contato/);assert.throws(()=>assertPublicQuery(s,'Contato pelo email teste@example.com'),/e-mails/);
  }finally{s.close();if(prior)process.env.OPORA_SEARCH_API_KEY=prior;else delete process.env.OPORA_SEARCH_API_KEY;}
});
test('resposta real do adaptador é validada, atribuída e salva sem conclusão fictícia',async()=>{
  const prior=process.env.OPORA_SEARCH_API_KEY;process.env.OPORA_SEARCH_API_KEY='test-only-not-a-real-key';const s=fresh();
  try{
    const r=createResearch(s,{question:'Políticas públicas de publicidade',purpose:'Conferir regras',public_query_confirmed:true});let calls=0;
    const fake=(async()=>{calls++;return new Response(JSON.stringify({web:{results:[{title:'Fixture oficial',url:'https://example.com/policy',description:'Resposta de teste do conector.'}]}}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
    await performResearch(s,r.id,fake);await performResearch(s,r.id,fake);assert.equal(calls,1);assert.equal(s.all('SELECT * FROM evidence').length,1);const e=s.get('SELECT * FROM evidence')!;assert.equal(e.url,'https://example.com/policy');assert.ok(e.limitations.includes('não verificada'));assert.equal(e.published_on,null);
  }finally{s.close();if(prior)process.env.OPORA_SEARCH_API_KEY=prior;else delete process.env.OPORA_SEARCH_API_KEY;}
});
test('leitura por URL recusa redes privadas e esquemas perigosos',async()=>{
  for(const address of ['127.0.0.1','10.2.3.4','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicAddress(address),false,address);
  for(const url of ['http://example.com','https://localhost','https://127.0.0.1','https://169.254.169.254','https://user:password@example.com'])await assert.rejects(()=>publicURL(url));
});
test('linguagem natural propõe e só grava depois da confirmação, sem duplicar',async()=>{
  const s=fresh();try{
    const p=addProduct(s,{name:'Material Alfa',unit:'ml',unit_cost_cents:1000,effective_from:'2026-01-01'});
    const proposal=await propose(s,{input:'O produto Material Alfa agora custa R$ 25,50, a partir de hoje.'});assert.equal(proposal.operation,'cost');assert.equal(s.all('SELECT * FROM product_costs WHERE product_id=?',p.id).length,1);
    confirmProposal(s,proposal.id);confirmProposal(s,proposal.id);assert.equal(s.all('SELECT * FROM product_costs WHERE product_id=?',p.id).length,2);
    assert.equal(localInterpret(s,'Recebi R$ 950,00 de Daniela no Pix hoje').operation,'answer');
  }finally{s.close();}
});
