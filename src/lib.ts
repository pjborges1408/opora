export type Row = Record<string, any>;
export interface State {
  today:string;
  financial:{month:string;totals:Row;sales:Row[];expenses:Row[];by_service:Row[];formulas:Record<string,string>;[key:string]:any};
  contacts:Row[];services:Row[];products:Row[];materials:Row[];simulations:Row[];recommendations:Row[];
  decisions:Row[];research:Row[];evidence:Row[];schedules:Row[];jobs:Row[];events:Row[];dependencies:Row[];
  settings:Record<string,string>;opportunities:Row[];quotes:Row[];campaigns:Row[];appointments:Row[];integrations:Row;usage:Row[];
}
export const brl=(value:number|null|undefined)=>value==null?'A confirmar':(value/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export const day=(value:string|null|undefined)=>value?new Date(value.length===10?value+'T12:00:00-03:00':value).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Data não informada';
export const dateInput=(value?:string|null)=>value??'';
export function parseMoney(input:string) {
  let value=input.replace(/R\$|\s/g,'');
  if(value.includes(','))value=value.replace(/\./g,'').replace(',','.');
  if(!/^\d+(\.\d{1,2})?$/.test(value))throw new Error('Informe um valor válido, como 950,00.');
  const [whole,decimal='']=value.split('.');const amount=Number(whole)*100+Number(decimal.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount) || amount>1_000_000_000_00)throw new Error('Valor fora do limite permitido.');
  return amount;
}
export const editMoney=(cents:number)=>(cents/100).toFixed(2).replace('.',',');
export async function request(path:string,body?:unknown,key?:string) {
  const res=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key??crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await res.json();if(!res.ok)throw new Error(result.error??'Não foi possível concluir.');return result;
}
