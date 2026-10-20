# NF Control — Entrada e Saída

React + Vite no front, **Netlify Functions + Netlify Blobs** como backend/banco (tudo dentro da Netlify, sem servidor ou MySQL externo).

## Publicar na Netlify
1. Suba esta pasta para um repositório (GitHub/GitLab) e use **Add new site → Import an existing project**.
   (Arrastar a pasta `dist` NÃO funciona: as Functions e o banco só são criados quando a Netlify faz o build.)
2. Build command `npm run build`, publish directory `dist` (já definidos no `netlify.toml`).
3. Em **Site configuration → Environment variables** (recomendado):
   - `RULES_PASSWORD` — senha da aba de regras (se não definir, usa `Cd21092425`)
   - `SESSION_SECRET` — qualquer texto longo e aleatório
4. Coloque sua logo em `client/public/logo.png` antes de publicar.

## Rodar localmente
```
npm install
npm run dev     # netlify dev: site + Functions + Blobs em http://localhost:8888
npm test        # testes do motor de conciliação e da API
```

## Alertas e estoque externo
- **Central de alertas** (dashboard): NF que saiu e não deu entrada no outro lado, divergência de quantidade entre saída e entrada da mesma NF, entrada no fornecedor sem saída registrada, saldo parado há muitos dias, retorno sem saída e possível lançamento duplicado.
- **Prazos** ficam em `shared/insights.ts` (`THRESHOLDS`): trânsito 3/7 dias, saldo sem retorno 15/30 dias.
- **Aba Estoque externo**: saldo fora da HD por PN, dividido em trânsito → fornecedor, no fornecedor (estimado) e trânsito → HD, com idade e NFs em aberto.

## Conferência, histórico e inventário
- **Conferência**: toda NF lançada gera duas conferências — carregamento (quem emite) e recebimento (quem recebe). NF da HD: HD confere a carga e a Vulcano o recebimento; NF da Vulcano: o inverso. Marque os itens, informe a quantidade contada, anexe foto e envie. Depois de enviada, não pode ser alterada (só receber comentários).
- **Histórico**: conferências e inventários enviados, com responsável, fotos, divergências e comentários.
- **Inventário semanal**: a HD gera (exige a senha) com o que deveria estar na Vulcano; a Vulcano conta e envia. Um por semana ISO.
- Fotos ficam no Netlify Blobs (reduzidas para ~1280 px no navegador). A tela atualiza sozinha a cada 60 s.

## NF de referência (saída do fornecedor)
- Ao lançar **Saída Fornecedor → HD**, informe a **NF de saída** (da Vulcano) e a **NF de referência** (a NF de entrada, enviada pela HD). Várias referências: separe por `+`.
- O sistema só aceita referência de NF que a HD já enviou e mostra, em tempo real, se PNs e quantidades casam (respeitando as regras de retrabalho e devoluções em partes).
- Se não casar, pede confirmação e gera alerta crítico. Sem referência (lançamentos antigos), gera alerta de atenção.
- Na **Conferência**, clique na NF para abrir a lista de PNs e dar o check item a item.
