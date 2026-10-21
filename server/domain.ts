import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { Store, id, now, today, type Row } from './database.ts';

export class DomainError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const money = z.number().int().min(0).max(1_000_000_000_00);
export const date = z.iso.date();
export const text = z.string().trim().min(1).max(2000);
const cents = (n: number) => (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const requireRow = (r: Row | undefined, message = 'Registro não encontrado'): Row => {
  if (!r) throw new DomainError(message, 404);
  return r;
};

export const saleSchema = z.object({
  external_id: z.string().trim().min(1).max(150), contact_name: text, sold_on: date,
  gross_cents: money.positive(), discount_cents: money.default(0), payment_method: z.enum(['Pix','Cartão','Dinheiro','Transferência']),
  installments: z.number().int().min(1).max(48).default(1), duration_minutes: z.number().int().positive().max(1440).nullable().default(null),
  net_received_cents: money.default(0), fee_cents: money.default(0), received_on: date.nullable().default(null),
  source: text.default('Informado pela profissional'),
  items: z.array(z.object({ service_name: text, allocated_cents: money.nullable().default(null), performed_on: date.nullable().default(null) })).min(1).max(20)
}).superRefine((s, ctx) => {
  if (s.discount_cents > s.gross_cents) ctx.addIssue({code:'custom',message:'O desconto excede o valor da venda.'});
  if (s.net_received_cents+s.fee_cents > s.gross_cents-s.discount_cents) ctx.addIssue({code:'custom',message:'Recebimentos e taxas excedem a venda.'});
  const known = s.items.filter(i => i.allocated_cents !== null);
  if (known.length && (known.length !== s.items.length || known.reduce((a,i)=>a+i.allocated_cents!,0) !== s.gross_cents-s.discount_cents)) {
    ctx.addIssue({code:'custom',message:'Divida o valor líquido de descontos entre todos os itens, ou deixe todos sem divisão.'});
  }
});

export function contact(s: Store, name: string, source: string) {
  // Exact normalized names are reused, without merging ambiguous near matches.
  const existing = s.all('SELECT * FROM contacts').find(c => fold(c.name).trim() === fold(name).trim());
  if (existing) return existing.id as string;
  const key=id(); s.run('INSERT INTO contacts VALUES(?,?,?,?)',key,name,source,now()); return key;
}
export function service(s: Store, name: string) {
  const existing=s.all('SELECT * FROM services').find(c=>fold(c.name)===fold(name));
  if(existing) return existing.id as string;
  const key=id(); s.run('INSERT INTO services VALUES(?,?)',key,name); return key;
}
export function importSaleInTransaction(s: Store, raw: unknown) {
  const v=saleSchema.parse(raw);
  const existing=s.get('SELECT * FROM sales WHERE external_id=?',v.external_id);
  if(existing) {
    const lines=s.all('SELECT i.*,p.name service_name FROM sale_items i JOIN services p ON p.id=i.service_id WHERE sale_id=? ORDER BY i.rowid',existing.id);
    const received=s.get('SELECT COALESCE(SUM(net_cents),0) net,COALESCE(SUM(fee_cents),0) fees FROM receipts WHERE sale_id=?',existing.id)!;
    const person=s.get('SELECT name FROM contacts WHERE id=?',existing.contact_id)!;
    const same=existing.sold_on===v.sold_on && existing.gross_cents===v.gross_cents && existing.discount_cents===v.discount_cents && existing.payment_method===v.payment_method && existing.installments===v.installments && fold(person.name)===fold(v.contact_name) && received.net===v.net_received_cents && received.fees===v.fee_cents && lines.length===v.items.length && lines.every((a,i)=>fold(a.service_name)===fold(v.items[i].service_name) && a.allocated_cents===v.items[i].allocated_cents);
    if(!same) throw new DomainError('A referência de importação já existe com dados diferentes. Corrija o registro existente; a importação não o sobrescreve.',409);
    return { id: existing.id, duplicate: true };
  }
  // Catch the same business record even if the import reference was changed.
  const person=contact(s,v.contact_name,v.source);
  const duplicate=s.get('SELECT id FROM sales WHERE contact_id=? AND sold_on=? AND gross_cents=? AND discount_cents=? AND payment_method=?',person,v.sold_on,v.gross_cents,v.discount_cents,v.payment_method);
  if(duplicate) throw new DomainError('Há uma venda com o mesmo contato, data e valor. Confira antes de importar novamente.',409);
  const key=id();
  s.run('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?,?)',key,v.external_id,person,v.sold_on,v.gross_cents,v.discount_cents,v.payment_method,v.installments,v.duration_minutes,v.source,now());
  // Explicit columns keep future schema migrations independent of positional data.
  for(const item of v.items) s.run('INSERT INTO sale_items(id,sale_id,service_id,allocated_cents,performed_on) VALUES(?,?,?,?,?)',id(),key,service(s,item.service_name),item.allocated_cents,item.performed_on);
  if(v.net_received_cents || v.fee_cents) s.run('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)',id(),key,v.net_received_cents,v.fee_cents,v.received_on,v.source,now());
  invalidate(s,'sales',key);
  s.event('sales',key,'Venda importada',null,v,['Resumo financeiro recalculado','Diagnóstico aguardando revisão']);
  return {id:key,duplicate:false};
}
export const importSale = (s: Store, raw: unknown) => s.transaction(()=>importSaleInTransaction(s,raw));

// Integer cents with largest-remainder allocation; the allocated fees always sum to the actual fee.
export function allocateFees(items:Row[],feeCents:number):Map<string,number|null> {
  const total=items.reduce((a,i)=>a+(i.allocated_cents??0),0);
  if(items.some(i=>i.allocated_cents===null))return new Map(items.map(i=>[i.id,null]));
  if(!total)return new Map(items.map(i=>[i.id,0]));
  const parts=items.map((item,index)=>{const numerator=BigInt(feeCents)*BigInt(item.allocated_cents);return {id:item.id,index,amount:Number(numerator/BigInt(total)),remainder:numerator%BigInt(total)};});
  let remaining=feeCents-parts.reduce((a,p)=>a+p.amount,0);
  const ordered=[...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
  for(const p of ordered){if(remaining<=0)break;p.amount++;remaining--;}
  return new Map(parts.map(p=>[p.id,p.amount]));
}

export function seed(s: Store, initialSales?:unknown[]) {
  if(s.get("SELECT 1 FROM meta WHERE key='confirmed-october-2026'")) return;
  const path=process.env.OPORA_INITIAL_IMPORT??'.local/imports/confirmed-october-2026.json';
  const rows=initialSales??(existsSync(path)?z.object({sales:z.array(z.unknown()).max(500)}).parse(JSON.parse(readFileSync(path,'utf8'))).sales:[]);
  if(!rows.length) {
    for(const name of ['Bioestimulador','Botox','Preenchimento labial'])service(s,name);
    return;
  }
  s.transaction(()=>{
    for(const row of rows) importSaleInTransaction(s,row);
    s.run('INSERT INTO meta VALUES(?,?)','confirmed-october-2026',now());
    s.run("INSERT OR IGNORE INTO settings VALUES('clinic_name',?,?)",'Dra. Carolinna Padilha',now());
    s.run("INSERT OR IGNORE INTO settings VALUES('region',?,?)",'Vitória/ES',now());
  });
  runDiagnostics(s);
}

export function listSales(s: Store, month?: string): Row[] {
  const sales=s.all(`SELECT s.*,c.name contact_name FROM sales s JOIN contacts c ON c.id=s.contact_id ${month?'WHERE substr(s.sold_on,1,7)=?':''} ORDER BY sold_on DESC,s.rowid DESC`,...(month?[month]:[]));
  return sales.map(sale=>{
    const items=s.all('SELECT i.*,p.name service_name FROM sale_items i JOIN services p ON p.id=i.service_id WHERE sale_id=?',sale.id);
    const receipts=s.all('SELECT * FROM receipts WHERE sale_id=? ORDER BY rowid',sale.id);
    const refunds=s.all('SELECT * FROM refunds WHERE sale_id=?',sale.id);
    const net=receipts.reduce((a,r)=>a+r.net_cents,0), fees=receipts.reduce((a,r)=>a+r.fee_cents,0);
    const refunded=refunds.reduce((a,r)=>a+r.amount_cents,0);
    const feesByItem=allocateFees(items,fees);
    for(const item of items) {item.allocated_fee_cents=feesByItem.get(item.id)??null;item.contribution_cents=item.allocated_cents===null || item.direct_cost_cents===null || item.allocated_fee_cents===null || (refunded>0&&items.length>1)?null:item.allocated_cents-item.allocated_fee_cents-item.direct_cost_cents-(items.length===1?refunded:0);}
    const allCosts=items.every(i=>i.direct_cost_cents!==null);
    const cost=items.reduce((a,i)=>a+(i.direct_cost_cents??0),0);
    return {...sale,items,receipts,refunds,net_received_cents:net,fee_cents:fees,refunded_cents:refunded,
      after_fees_cents:sale.gross_cents-sale.discount_cents-fees,
      receivable_cents:Math.max(0,sale.gross_cents-sale.discount_cents-net-fees),
      direct_cost_cents:allCosts?cost:null,
      contribution_cents:allCosts?sale.gross_cents-sale.discount_cents-fees-refunded-cost:null,
      margin_per_hour_cents:allCosts && sale.duration_minutes?Math.round((sale.gross_cents-sale.discount_cents-fees-refunded-cost)*60/sale.duration_minutes):null,
      allocation_pending:items.some(i=>i.allocated_cents===null),
      performance_pending:items.some(i=>!i.performed_on),
    };
  });
}

export function financial(s: Store, month: string) {
  const sales=listSales(s,month);
  const expenses=s.all('SELECT * FROM expenses WHERE substr(due_on,1,7)=? ORDER BY due_on',month);
  const receipts=s.all('SELECT r.*,c.name contact_name FROM receipts r JOIN sales v ON v.id=r.sale_id JOIN contacts c ON c.id=v.contact_id');
  const dated=receipts.filter(r=>r.received_on?.startsWith(month));
  const undated=receipts.filter(r=>!r.received_on);
  const cashExpenses=s.all("SELECT * FROM expenses WHERE substr(paid_on,1,7)=? AND category!='transfer'",month);
  const cashRefunds=s.all('SELECT * FROM refunds WHERE substr(refunded_on,1,7)=?',month);
  const operating=expenses.filter(e=>['operational','tax'].includes(e.category));
  const sum=(key:string)=>sales.reduce((a,r)=>a+(r[key as keyof typeof r] as number),0);
  const performed=s.all('SELECT i.*,v.sold_on FROM sale_items i JOIN sales v ON v.id=i.sale_id WHERE substr(performed_on,1,7)=?',month);
  const performedAllocated=performed.filter(i=>i.allocated_cents!==null);
  const reviewed=!!s.get('SELECT 1 FROM period_reviews WHERE month=? AND expenses_reviewed_at IS NOT NULL',month);
  const partial=sales.some(r=>r.direct_cost_cents===null || r.performance_pending || r.allocation_pending) || performed.some(i=>i.allocated_cents===null || i.direct_cost_cents===null) || !reviewed;
  const serviceTotals:Row[]=s.all('SELECT * FROM services').map(p=>{
    const items:Row[]=sales.flatMap(v=>v.items.filter((i:Row)=>i.service_id===p.id));
    return {...p,known_sold_cents:items.filter(i=>i.allocated_cents!==null).reduce((a,i)=>a+i.allocated_cents,0),unallocated_items:items.filter(i=>i.allocated_cents===null).length,count:items.length,
      contribution_cents:items.every(i=>i.contribution_cents!==null)?items.reduce((a,i)=>a+i.contribution_cents,0):null,
      known_cost_cents:items.filter(i=>i.direct_cost_cents!==null).reduce((a,i)=>a+i.direct_cost_cents,0),missing_costs:items.filter(i=>i.direct_cost_cents===null).length};
  }).filter(p=>p.count);
  const realizedCosts=performed.reduce((a,i)=>a+(i.direct_cost_cents??0),0);
  const operatingTotal=operating.reduce((a,e)=>a+e.amount_cents,0);
  const realizedFees=performed.reduce((a,i)=>{
    const sale=s.get('SELECT * FROM sales WHERE id=?',i.sale_id)!;
    const fees=s.get('SELECT COALESCE(SUM(fee_cents),0) total FROM receipts WHERE sale_id=?',i.sale_id)!.total;
    return a+(allocateFees(s.all('SELECT * FROM sale_items WHERE sale_id=? ORDER BY rowid',sale.id),fees).get(i.id)??0);
  },0);
  const realized=performedAllocated.reduce((a,i)=>a+i.allocated_cents,0);
  const refunds=s.all('SELECT * FROM refunds WHERE substr(refunded_on,1,7)=?',month).reduce((a,r)=>a+r.amount_cents,0);
  return {
    month,sales,expenses,by_service:serviceTotals,
    totals:{gross_cents:sum('gross_cents'),discount_cents:sum('discount_cents'),fee_cents:sum('fee_cents'),after_fees_cents:sum('after_fees_cents'),
      received_cents:sum('net_received_cents'),receivable_cents:sum('receivable_cents'),refunded_cents:sum('refunded_cents'),
      known_performed_revenue_cents:realized,performance_confirmed_items:performed.length,
      known_direct_cost_cents:sales.reduce((a,v)=>a+v.items.reduce((x:number,i:Row)=>x+(i.direct_cost_cents??0),0),0),
      operating_expenses_cents:operatingTotal,result_cents:partial?null:realized-realizedCosts-Math.round(realizedFees)-operatingTotal-refunds,
      cash_in_cents:dated.reduce((a,r)=>a+r.net_cents,0),cash_out_cents:cashExpenses.reduce((a,e)=>a+e.amount_cents,0)+cashRefunds.reduce((a,r)=>a+r.amount_cents,0),
      undated_received_cents:undated.reduce((a,r)=>a+r.net_cents,0),partial,
      missing_cost_items:sales.flatMap(v=>v.items).filter(i=>i.direct_cost_cents===null).length,
      allocation_pending_sales:sales.filter(v=>v.allocation_pending).length,
      performance_pending_sales:sales.filter(v=>v.performance_pending).length,
      expenses_reviewed:reviewed
    },
    formulas:{gross_cents:'Soma dos valores das vendas únicas do mês, antes dos descontos.',fee_cents:'Soma das taxas vinculadas às vendas do mês. Parcelas não são novas vendas.',
      after_fees_cents:'Vendido − descontos − taxas. Não implica data de recebimento.',received_cents:'Recebimentos confirmados vinculados às vendas deste mês, mesmo quando a data bancária não foi informada. Estornos aparecem separadamente.',
      receivable_cents:'Vendido − descontos − (recebimentos + taxas). Estorno pago não reabre a cobrança.',
      result_cents:'Receita dos itens realizados no mês − consumo efetivo de materiais − taxas rateadas proporcionalmente aos itens − despesas operacionais − impostos − estornos do mês. Parcial enquanto custos, realização, divisão de valores ou conciliação de despesas estiverem pendentes.',
      cash_in_cents:'Somente recebimentos com data bancária neste mês; recebimentos sem data ficam fora do fluxo mensal.',
      cash_out_cents:'Saídas pagas no mês, incluindo compras de estoque, investimentos, retiradas e estornos. Transferências internas são apresentadas separadamente.'},
    cash_entries:dated,undated_receipts:undated,cash_expenses:cashExpenses,cash_refunds:cashRefunds,
    future_payables:s.all('SELECT * FROM expenses WHERE paid_on IS NULL ORDER BY due_on'),
    note:'Dados comerciais e operacionais. Datas de venda não foram usadas como datas de crédito nem como confirmação de atendimento.'
  };
}

export function queue(s: Store, type: string, key: string, payload: unknown) {
  const existing=s.get('SELECT * FROM jobs WHERE dedupe_key=?',key);
  if(existing && ['pending','running'].includes(existing.status)) return existing.id;
  if(existing) { s.run("UPDATE jobs SET status='pending',attempts=0,error=NULL,payload_json=?,available_at=?,updated_at=? WHERE id=?",JSON.stringify(payload),now(),now(),existing.id); return existing.id; }
  const jobId=id();s.run('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',jobId,key,type,JSON.stringify(payload),'pending',0,3,now(),null,now(),now()); return jobId;
}
export function depend(s: Store, type: string, source: string, targetType: string, target: string, mode='analysis') {
  if(type===targetType && source===target) throw new DomainError('Dependência circular.');
  const cycle=s.get(`WITH RECURSIVE reachable(t,i) AS (
    SELECT target_type,target_id FROM dependencies WHERE source_type=? AND source_id=?
    UNION SELECT d.target_type,d.target_id FROM dependencies d JOIN reachable r ON d.source_type=r.t AND d.source_id=r.i
  ) SELECT 1 FROM reachable WHERE t=? AND i=? LIMIT 1`,targetType,target,type,source);
  if(cycle) throw new DomainError('Dependência circular.');
  s.run('INSERT OR IGNORE INTO dependencies VALUES(?,?,?,?,?)',type,source,targetType,target,mode);
}
export function invalidate(s: Store, type: string, entity: string) {
  const visited=new Set<string>();const todo:[[string,string]]|[string,string][]=[[type,entity]]; const impacts:string[]=[];
  while(todo.length) {
    const [t,key]=todo.shift()!; if(visited.has(t+':'+key))continue;visited.add(t+':'+key);
    for(const d of s.all("SELECT * FROM dependencies WHERE source_type=? AND (source_id=? OR source_id='*')",t,key)) {
      if(d.mode==='external') { impacts.push('Ação externa aguarda autorização específica');continue; }
      if(d.target_type==='simulations') { recalculateSimulation(s,d.target_id);impacts.push('Simulação futura recalculada'); }
      if(d.target_type==='recommendations') {s.run('UPDATE recommendations SET stale=1,updated_at=? WHERE id=?',now(),d.target_id);impacts.push('Recomendação sinalizada para revisão');}
      todo.push([d.target_type,d.target_id]);
    }
  }
  queue(s,'diagnostics','diagnostics',{});
  return [...new Set(impacts)];
}

export const productSchema=z.object({name:text,unit:text,unit_cost_cents:money,effective_from:date,source:text.default('Informado pela profissional')});
export function addProduct(s:Store,raw:unknown) {
  const v=productSchema.parse(raw);
  return s.transaction(()=>{
    const key=id();s.run('INSERT INTO products VALUES(?,?,?,?,?)',key,v.name,v.unit,v.source,now());
    s.run('INSERT INTO product_costs VALUES(?,?,?,?,?,?)',id(),key,v.unit_cost_cents,v.effective_from,v.source,now());
    s.event('products',key,'Produto cadastrado',null,v);return {id:key};
  });
}
export function changeCost(s: Store, productId: string, raw: unknown) {
  const v=z.object({unit_cost_cents:money,effective_from:date,source:text,correction_reason:text.optional()}).parse(raw);
  return s.transaction(()=>{
    requireRow(s.get('SELECT * FROM products WHERE id=?',productId));
    const before=s.get('SELECT * FROM product_costs WHERE product_id=? AND effective_from=?',productId,v.effective_from);
    if(before && !v.correction_reason) throw new DomainError('Já existe um custo para essa vigência. Para corrigi-lo explicitamente, informe o motivo da correção; o valor anterior ficará no histórico.',409);
    if(before)s.run('UPDATE product_costs SET unit_cost_cents=?,source=? WHERE id=?',v.unit_cost_cents,v.source,before.id);
    else s.run('INSERT INTO product_costs VALUES(?,?,?,?,?,?)',id(),productId,v.unit_cost_cents,v.effective_from,v.source,now());
    s.run('UPDATE products SET updated_at=? WHERE id=?',now(),productId);
    const impacts=invalidate(s,'products',productId);
    s.event('products',productId,before?'Correção explícita de vigência: '+v.correction_reason:'Custo atualizado com nova vigência',before,v,[...impacts,'Custos de atendimentos anteriores preservados']);
    return {impacts:[...impacts,'Custos de atendimentos anteriores preservados']};
  });
}
export function recalculateSimulation(s:Store,key:string) {
  const sim=requireRow(s.get('SELECT * FROM simulations WHERE id=?',key));
  const materials=s.all('SELECT m.*,p.name FROM service_materials m JOIN products p ON p.id=m.product_id WHERE service_id=?',sim.service_id);
  const missing:string[]=[];let cost=0;
  if(!materials.length) missing.push('Consumo de materiais não informado');
  for(const m of materials) {
    const c=s.get('SELECT * FROM product_costs WHERE product_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1',m.product_id,sim.as_of);
    if(!c) missing.push(m.name);else cost+=Math.round(m.quantity*c.unit_cost_cents);
    depend(s,'products',m.product_id,'simulations',key,'deterministic');
  }
  s.run('UPDATE simulations SET cost_cents=?,margin_cents=?,missing_costs=?,stale=0,updated_at=? WHERE id=?',missing.length?null:cost,missing.length?null:sim.price_cents-cost,JSON.stringify(missing),now(),key);
}
export function addSimulation(s:Store,raw:unknown) {
  const v=z.object({service_id:text,price_cents:money.positive(),duration_minutes:z.number().int().min(1).max(1440).nullable().default(null),as_of:date}).parse(raw);
  return s.transaction(()=>{
    requireRow(s.get('SELECT * FROM services WHERE id=?',v.service_id));
    const key=id();s.run('INSERT INTO simulations VALUES(?,?,?,?,?,?,?,?,?,?)',key,v.service_id,v.price_cents,v.duration_minutes,v.as_of,null,null,'[]',0,now());
    recalculateSimulation(s,key);s.event('simulations',key,'Simulação criada',null,v);return {id:key};
  });
}
export function correctReceipt(s:Store,key:string,raw:unknown) {
  const v=z.object({net_cents:money,fee_cents:money,received_on:date.nullable(),reason:text}).parse(raw);
  return s.transaction(()=>{
    const before=requireRow(s.get('SELECT * FROM receipts WHERE id=?',key));
    const sale=requireRow(s.get('SELECT * FROM sales WHERE id=?',before.sale_id));
    const others=s.get('SELECT COALESCE(SUM(net_cents+fee_cents),0) total FROM receipts WHERE sale_id=? AND id!=?',sale.id,key)!.total;
    if(others+v.net_cents+v.fee_cents>sale.gross_cents-sale.discount_cents) throw new DomainError('Recebimentos e taxas excedem o valor da venda.');
    const refunded=s.get('SELECT COALESCE(SUM(amount_cents),0) total FROM refunds WHERE sale_id=?',sale.id)!.total;
    const otherNet=s.get('SELECT COALESCE(SUM(net_cents),0) total FROM receipts WHERE sale_id=? AND id!=?',sale.id,key)!.total;
    if(otherNet+v.net_cents<refunded) throw new DomainError('O recebimento corrigido não pode ser menor que os estornos já pagos.');
    s.run('UPDATE receipts SET net_cents=?,fee_cents=?,received_on=?,updated_at=? WHERE id=?',v.net_cents,v.fee_cents,v.received_on,now(),key);
    const impacts=['Vendido, taxas, recebido, saldo a receber e fluxo de caixa recalculados',...invalidate(s,'sales',sale.id)];
    s.event('receipts',key,'Recebimento corrigido: '+v.reason,before,v,impacts);return {impacts};
  });
}

export function runDiagnostics(s:Store) {
  s.transaction(()=>{
    const sales=listSales(s);
    const missing=sales.filter(v=>v.direct_cost_cents===null);
    const combos=sales.filter(v=>v.allocation_pending);
    const undated=s.get('SELECT COUNT(*) n,SUM(net_cents) total FROM receipts WHERE received_on IS NULL')!;
    const old=s.all("SELECT * FROM opportunities WHERE stage IN ('new','proposal') AND last_contact_on < date(?,'-7 days')",today());
    const rules=[
      {key:'missing-costs',active:missing.length>0,title:'Descobrir o custo antes de avaliar a margem',finding:`${missing.length} venda(s) têm custos de materiais não informados.`,why:'Recebimento positivo não informa quanto sobrou.',action:'Informe o consumo e o custo efetivo dos materiais de cada atendimento.',effort:'Conferir notas e consumo dos atendimentos',impact:'Permite calcular a margem; ganho financeiro ainda desconhecido.',uncertainty:'Custos e realização dos procedimentos ainda precisam ser confirmados.',condition:'Reavaliar quando os consumos forem informados.',evidence:missing.map(v=>({type:'sales',id:v.id,summary:v.contact_name+': custo ausente'}))},
      {key:'unallocated',active:combos.length>0,title:'Separar os valores dos procedimentos',finding:`${combos.length} venda(s) sem atribuição completa do valor aos itens.`,why:'Comparar procedimentos sem divisão produz receita e margem incorretas.',action:'Confirme a divisão dos combos e identifique o procedimento não informado.',effort:'Conferir os orçamentos originais',impact:'Torna a comparação por procedimento confiável; sem estimativa de ganho.',uncertainty:'Nenhum rateio foi presumido.',condition:'Reavaliar ao completar a divisão e a identificação dos itens.',evidence:combos.map(v=>({type:'sales',id:v.id,summary:v.contact_name+': divisão pendente'}))},
      {key:'undated-receipts',active:undated.n>0,title:'Conciliar as datas dos recebimentos',finding:`${undated.n} recebimento(s), ${cents(undated.total??0)}, sem data bancária.`,why:'O total foi confirmado, mas o fluxo mensal de caixa ainda é incompleto.',action:'Confira o extrato e registre a data de cada crédito, sem usar a data da venda por suposição.',effort:'Conferir extrato bancário',impact:'Permite planejar o caixa; não altera o total já confirmado.',uncertainty:'Antecipações e datas bancárias não foram informadas.',condition:'Reavaliar quando todos os créditos tiverem data.',evidence:[{type:'sales',id:'*',summary:'Recebimentos confirmados sem data'}]},
      {key:'followups',active:old.length>0,title:'Revisar oportunidades sem contato recente',finding:`${old.length} oportunidade(s) abertas sem atualização há mais de sete dias.`,why:'É um sinal de acompanhamento pendente, não prova de perda de interesse.',action:'Revise o histórico e prepare um próximo contato, sem envio automático.',effort:'Revisão breve das oportunidades',impact:'Potencial comercial desconhecido até revisar os casos.',uncertainty:'Não há evidência de que a demora causou perda de vendas.',condition:'Reavaliar depois de registrar contato ou encerrar a oportunidade.',evidence:old.map(o=>({type:'opportunities',id:o.id,summary:o.title}))}
    ];
    for(const r of rules) {
      const existing=s.get('SELECT * FROM recommendations WHERE rule_key=?',r.key);
      if(!r.active) {if(existing)s.run("UPDATE recommendations SET status='resolved',stale=0,updated_at=? WHERE id=?",now(),existing.id);continue;}
      const key=existing?.id??id();
      if(existing) s.run('UPDATE recommendations SET finding=?,evidence_json=?,stale=0,updated_at=? WHERE id=?',r.finding,JSON.stringify(r.evidence),now(),key);
      else s.run('INSERT INTO recommendations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,r.key,r.title,r.finding,JSON.stringify(r.evidence),r.why,r.action,r.effort,r.impact,'Sem atribuição causal; cálculo determinístico sobre registros disponíveis.',r.uncertainty,r.condition,'open',0,now(),now());
      for(const e of r.evidence)depend(s,e.type,e.id,'recommendations',key);
    }
  });
}

export function reviseEvidence(s:Store,key:string,raw:unknown) {
  const v=z.object({excerpt:text,limitations:text,reason:text}).parse(raw);
  return s.transaction(()=>{
    const before=requireRow(s.get('SELECT * FROM evidence WHERE id=?',key));
    s.run('UPDATE evidence SET excerpt=?,limitations=?,version=version+1 WHERE id=?',v.excerpt,v.limitations,key);
    const impacts=invalidate(s,'evidence',key);
    s.event('evidence',key,'Evidência corrigida: '+v.reason,before,v,impacts);return {impacts};
  });
}

export function decide(s:Store,key:string,raw:unknown) {
  const v=z.object({choice:z.enum(['accept','adjust','defer','reject']),reason:z.string().max(2000).optional(),action:z.string().max(3000).optional(),review_on:date.nullable().default(null)}).parse(raw);
  return s.transaction(()=>{
    const r=requireRow(s.get('SELECT * FROM recommendations WHERE id=?',key));
    if(r.stale)throw new DomainError('Revise a recomendação desatualizada antes de decidir.',409);
    const references=JSON.parse(r.evidence_json) as Row[];
    const snapshot={recommendation:r,evidence:references.map(e=>({...e,record:e.type==='evidence'?s.get('SELECT * FROM evidence WHERE id=?',e.id):e.type==='sales'?(e.id==='*'?listSales(s):listSales(s).find(v=>v.id===e.id)):null})),recorded_at:now()};
    const keyId=id();s.run('INSERT INTO decisions(id,recommendation_id,choice,reason,action,review_on,executed_on,outcome,outcome_on,learned,created_at,updated_at,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',keyId,key,v.choice,v.reason??null,v.action??r.action,v.review_on,null,null,null,null,now(),now(),JSON.stringify(snapshot));
    s.run('UPDATE recommendations SET status=?,updated_at=? WHERE id=?',v.choice==='reject'?'rejected':v.choice==='defer'?'deferred':'accepted',now(),key);
    s.event('decisions',keyId,'Decisão registrada',null,v,['Nenhuma ação externa foi executada']);return {id:keyId};
  });
}
export function recordOutcome(s:Store,key:string,raw:unknown) {
  const v=z.object({executed_on:date,outcome:text,outcome_on:date,learned:text}).parse(raw);
  return s.transaction(()=>{
    const before=requireRow(s.get('SELECT * FROM decisions WHERE id=?',key));
    if(!['accept','adjust'].includes(before.choice))throw new DomainError('Aceite ou ajuste a sugestão antes de registrar execução.');
    if(v.outcome_on<v.executed_on)throw new DomainError('O resultado não pode ser anterior à execução.');
    s.run('UPDATE decisions SET executed_on=?,outcome=?,outcome_on=?,learned=?,updated_at=? WHERE id=?',v.executed_on,v.outcome,v.outcome_on,v.learned,now(),key);
    s.event('decisions',key,'Resultado e aprendizado registrados',before,v,['Aprendizado salvo como relato; causalidade não presumida']);return {id:key};
  });
}

export function idempotent<T>(s: Store,key: string | undefined,body:unknown,fn:()=>T):T {
  if(!key || key.length>150) throw new DomainError('Envie uma chave Idempotency-Key de até 150 caracteres.');
  const fingerprint=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return s.transaction(()=>{
    const previous=s.get('SELECT * FROM requests WHERE request_key=?',key);
    if(previous) {
      if(previous.fingerprint!==fingerprint)throw new DomainError('Chave de operação já usada com outro conteúdo.',409);
      return JSON.parse(previous.response_json);
    }
    const result=fn();s.run('INSERT INTO requests VALUES(?,?,?,?)',key,fingerprint,JSON.stringify(result),now());return result;
  });
}
