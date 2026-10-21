# Opora

Gestão comercial e operacional para uma clínica, com financeiro rastreável, contexto persistente e decisões acompanháveis. Interface em português, adaptada ao celular.

O repositório estava vazio. Esta implementação foi criada a partir do documento fornecido; não houve migração de um sistema anterior. O artefato do Claude respondeu com acesso bloqueado e seu código não foi inspecionado.

## Executar

Requer **Node 24** (SQLite nativo) e npm. Na raiz do projeto:

```bash
npm ci --cache /workspace/.cache/npm
npm run build
npm start
```

O servidor escuta somente no loopback, porta 3000. Para desenvolvimento com atualização da interface, execute `npm run dev` e `npm run dev:ui` em terminais separados. O Vite encaminha `/api` para o backend.

As variáveis de `.env.example` devem ser exportadas ou injetadas pelo ambiente; o arquivo não é carregado automaticamente. Não inclua credenciais no frontend ou no Git.

## Como usar

1. **Hoje:** confira os totais e as poucas prioridades calculadas. Clique nos números para ver origem e fórmula. Perguntas recebem respostas baseadas nos registros; a interpretação padrão usa regras locais, claramente identificadas.
2. **Clínica / Financeiro:** registre uma venda uma única vez; confira crédito e taxa pelo extrato; divida os valores dos combos; confirme realização e consumo de materiais. Registre despesas em suas categorias e marque a conferência do mês.
3. **Clínica / Materiais e condições:** cadastre produtos, custos por unidade e vigências. Defina consumos padrão e salve simulações. Novas vigências recalculam as estimativas afetadas e preservam os custos efetivos antigos. Uma correção de vigência existente exige motivo explícito.
4. **Clínica / Oportunidades e agenda:** registre origem conhecida, prepare orçamentos, confirme aceites e mantenha uma agenda local. Aceitar um orçamento atualiza a oportunidade, sem criar venda, crédito ou mensagem automática.
5. **Investigar e decidir:** salve uma pergunta com finalidade prática, consulte uma fonte pública por URL, corrija evidências e prepare hipóteses vinculadas às fontes. Um trecho de buscador não é apresentado como página verificada ou prova de demanda local.
6. **Histórico:** aceite, ajuste, adie ou rejeite uma proposta; registre execução, resultado e aprendizado; consulte alterações e impactos. A decisão guarda uma fotografia das evidências disponíveis na ocasião. Aprendizados podem ser corrigidos e não viram preferências permanentes automaticamente.
7. **Contexto e conexões:** informe disponibilidade, meta e preferências explícitas. Consulte o estado real das integrações e exporte os dados.

Exemplo de entrada local: `O produto Material Alfa agora custa R$ 25,50, a partir de hoje.` O produto precisa existir. A Opora apresenta uma proposta; somente a confirmação grava a alteração. Entradas ambíguas não produzem lançamentos. O registro de crédito local por linguagem natural aceita Pix, exige contato com venda única e data, e pede confirmação explícita da taxa zero na proposta. Correções de créditos existentes são feitas no financeiro.

## Dados reais, persistência e backup

- O banco fica em `.local/opora.sqlite`, com WAL, chaves estrangeiras e transações. `.local/` é ignorado pelo Git.
- Os seis registros reais fornecidos estão em `.local/imports/confirmed-october-2026.json`, arquivo local protegido e não versionado. A primeira inicialização faz a conciliação por referência estável, em transação. Um marcador impede reinserção na reinicialização.
- Uma cópia nova apenas do código começa sem pacientes ou vendas. O importador opcional usa `OPORA_INITIAL_IMPORT`; nunca aponta para as fixtures em uso real.
- Os testes usam identidades fictícias, bancos temporários e arquivos próprios. Não escrevem no banco da clínica.
- A exportação autenticada em JSON inclui dados e auditoria; não inclui credenciais. É um arquivo de dados para consulta, não um comando automático de restauração.
- `npm run backup` cria uma cópia SQLite consistente em `.local/backups/`. É possível escolher outro destino com `npm run backup -- /caminho/novo.sqlite`. Backups existentes não são sobrescritos. Para restaurar, pare o servidor e use uma cópia SQLite em outro caminho via `OPORA_DB`; preserve o banco original e seus arquivos WAL/SHM. Armazenamento e cópias fora desta máquina precisam ser providenciados na hospedagem.

## Regras financeiras

Todos os valores monetários são centavos inteiros, validados no servidor. O rateio de taxas usa inteiros e conserva os centavos.

| Informação | Regra |
| --- | --- |
| Vendido | Soma de vendas únicas, antes dos descontos; parcelas não são vendas |
| Após taxas | Vendido − descontos − taxas informadas |
| Recebido do grupo de vendas | Créditos confirmados vinculados às vendas do mês, com ou sem data bancária |
| Saldo a receber | Vendido − descontos − créditos − taxas; estorno pago não reabre cobrança |
| Caixa mensal | Somente créditos e saídas com datas bancárias/pagamento no mês |
| Receita realizada | Itens com realização e valor atribuído confirmados no mês |
| Resultado gerencial | Receita realizada − consumo efetivo − taxas proporcionais − despesas operacionais − impostos − estornos do período |
| Compra de estoque | Saída de caixa quando paga; não é abatida novamente como despesa de consumo |
| Investimentos e retiradas | Separados das despesas operacionais |
| Transferências | Categoria para transferências internas; não são receita, despesa nem variação do caixa consolidado |

Valores sem custo, sem divisão ou sem confirmação de realização impedem resultado definitivo. Despesas precisam ser conciliadas. O fluxo não representa saldo bancário: não existe saldo inicial presumido. Valores de combos não divididos continuam no total da venda e ficam fora dos totais individuais dos procedimentos. A alocação de taxas é proporcional aos valores confirmados dos itens, não uma tarifa individual informada pela operadora. Estornos de combos sem rateio não produzem margem individual definitiva.

Para os seis registros fornecidos, a verificação é: **R$ 9.280,00 vendidos, R$ 839,00 em taxas e R$ 8.441,00 recebidos**. Datas de venda não viram datas de crédito nem confirmação de atendimento. Custos ausentes não são zero.

## Conectores externos

### Busca

Configure `OPORA_SEARCH_API_KEY` no servidor, pelo mecanismo seguro do ambiente, e permita `api.search.brave.com` na rede. Não envie a chave no chat. O conector usa a API Brave Search, limita a cinco resultados por consulta, valida a resposta e salva URL, trecho, data de consulta, publicação quando verificável, região e limitações.

Sem chave, a pergunta fica **bloqueada por configuração**, sem evidências fictícias. Após configurar, use **Tentar novamente**. Consultas são públicas: existe confirmação explícita e bloqueio de nomes conhecidos, e-mails, telefones e documentos reconhecíveis. Essa minimização não dispensa a conferência humana do texto.

Pesquisas recorrentes são opcionais, autorizadas por pergunta e podem ser pausadas. O padrão de limite é 30 chamadas/mês, incluindo tentativas. `OPORA_SEARCH_MONTHLY_LIMIT` aceita de 1 a 10000; valores inválidos impedem chamadas. Não foram feitas chamadas pagas durante o desenvolvimento.

### Consulta direta por URL

Usa HTTPS público sem chave de busca, sem redirects, com timeout de 15 segundos, limite de 1 MB e apenas HTML/texto. Endereços internos e credenciais na URL são recusados. Há uma lista explícita de domínios oficiais; outros exigem `OPORA_SOURCE_ALLOWED_DOMAINS` (hosts separados por vírgula) e permissão na política de rede. Sites com login, bloqueio, CAPTCHA ou conteúdo gerado somente em JavaScript podem falhar. Nenhum texto de fonte é executado como instrução.

### IA opcional

O adaptador OpenAI aceita `OPORA_AI_API_KEY`, `OPORA_ENABLE_AI=1`, modelo em `OPORA_AI_MODEL` e limite em `OPORA_AI_MONTHLY_LIMIT` (padrão 20/mês). **Vem desabilitado.** Habilite somente após autorizar o provedor e seus custos. O endpoint de propostas aceita `use_ai: true` para interpretação textual, sem ferramentas, cálculos financeiros ou gravações automáticas. Nomes conhecidos e identificadores reconhecidos são minimizados; o envio de texto ao provedor deve ser autorizado pelo operador.

A interface padrão usa regras locais. Conectar uma chave não transforma essas regras em uma inteligência autônoma. Diagnóstico causal, aprendizado automático a partir de resultados, previsão de demanda e interpretação irrestrita ainda não estão implementados.

WhatsApp, Instagram, Meta Ads e agenda externa não estão conectados. Há agenda local e importação manual JSON. Áudio não foi implementado. Nenhuma comunicação, anúncio ou contratação é executada.

## Importação de vendas

Em **Financeiro → Importar registros**, use um objeto com `sales`. Reutilize a referência `external_id` ao reimportar. Conflitos são sinalizados, nunca sobrescritos silenciosamente. Exemplo fictício:

```json
{
  "sales": [{
    "external_id": "origem-venda-123",
    "contact_name": "Contato de exemplo",
    "sold_on": "2026-10-21",
    "gross_cents": 100000,
    "discount_cents": 0,
    "payment_method": "Pix",
    "installments": 1,
    "net_received_cents": 100000,
    "fee_cents": 0,
    "received_on": null,
    "source": "Importação manual conferida",
    "items": [{"service_name": "Botox", "allocated_cents": 100000, "performed_on": null}]
  }]
}
```

Para combos sem divisão, use `allocated_cents: null` em todos os itens. A API de mutação exige `Idempotency-Key`; a interface mantém a mesma chave em tentativas da mesma operação.

## Arquitetura e limites operacionais

React + TypeScript + Vite na interface; Express + Zod no servidor; SQLite nativo do Node 24. Uma clínica por banco/processo. Não é uma plataforma multiempresa: não há contas ou isolamento multi-inquilino. O escopo é comercial e operacional, sem prontuário ou recomendações clínicas.

Dependências ficam na tabela `dependencies`, com origem, destino e modo: determinístico, revisão de análise ou ação externa. Ciclos são recusados. Custos atualizam as simulações vinculadas imediatamente; correções financeiras recalculam os resumos; evidências alteradas sinalizam recomendações dependentes. Uma fila persistente agrupa revisões e limita retentativas. Veja [docs/architecture.md](docs/architecture.md).

O worker roda no servidor, mesmo sem navegador aberto. **Não roda quando o servidor ou esta máquina estão parados.** Produção contínua exige processo supervisionado, disco persistente, backup, HTTPS, monitoramento e credenciais de acesso. Não houve deploy ou publicação em produção.

A aplicação recusa escuta externa sem `OPORA_ACCESS_PASSWORD` (ao menos 16 caracteres) e `OPORA_PUBLIC_ORIGIN`. A senha fica no servidor; sessões têm cookie HttpOnly/SameSite e expiram em 12 horas. Em HTTPS, configure a origem HTTPS para o cookie Secure. O desenvolvimento local sem senha é restrito ao loopback, com validação de Host e Origin. Não use este modo como autenticação de produção.

## Verificação

```bash
npm run check       # TypeScript, build e testes de domínio/API
npm run test:e2e    # Chromium headless: desktop e celular, bancos temporários isolados
```

O Chromium de testes vem de um pacote npm com integridade no lockfile; não exige download separado pelo Playwright. A suíte cobre reconciliação, idempotência, rollback, custos e vigências, combos, correções de crédito, invalidação de evidência, snapshot da decisão, resultados, proteção de acesso e persistência após reinicializar. Respostas externas de fixtures estão identificadas como teste; não validam credenciais reais nem pesquisas reais.
