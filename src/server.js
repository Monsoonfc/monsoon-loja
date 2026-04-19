require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fse = require('fs-extra');
const path = require('path');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

async function readDB() { return fse.readJson(DB_PATH); }
async function writeDB(data) { return fse.writeJson(DB_PATH, data, { spaces: 2 }); }

// Produtos ativos
app.get('/api/produtos', async (req, res) => {
  const db = await readDB();
  res.json(db.produtos.filter(p => p.ativo));
});

// Jogos ativos
app.get('/api/jogos', async (req, res) => {
  const db = await readDB();
  res.json(db.jogos.filter(j => j.ativo && new Date(j.data) > new Date()));
});

// Checkout
app.post('/api/checkout', async (req, res) => {
  try {
    const { itens, cliente, entrega } = req.body;
    if (!itens || !itens.length) return res.status(400).json({ erro: 'Carrinho vazio' });
    if (!cliente?.nome || !cliente?.email || !cliente?.cpf) return res.status(400).json({ erro: 'Dados do cliente incompletos' });
    if (entrega?.tipo === 'entrega' && (!entrega.endereco?.rua || !entrega.endereco?.cep)) return res.status(400).json({ erro: 'Endereço incompleto' });

    const db = await readDB();
    const mpItens = [];
    const itensPedido = [];

    for (const item of itens) {
      if (item.tipo === 'camiseta') {
        const produto = db.produtos.find(p => p.id === item.id);
        if (!produto) return res.status(400).json({ erro: 'Produto nao encontrado' });
        if (!produto.estoque[item.tamanho] || produto.estoque[item.tamanho] < item.quantidade) return res.status(400).json({ erro: 'Sem estoque' });
        mpItens.push({ id: produto.id, title: produto.nome + ' - ' + item.tamanho, quantity: item.quantidade, unit_price: produto.preco, currency_id: 'BRL' });
        itensPedido.push({ ...item, preco_unit: produto.preco, nome: produto.nome });
      } else if (item.tipo === 'ingresso') {
        const jogo = db.jogos.find(j => j.id === item.id);
        if (!jogo) return res.status(400).json({ erro: 'Jogo nao encontrado' });
        if (jogo.ingressos_disponiveis < item.quantidade) return res.status(400).json({ erro: 'Ingressos insuficientes' });
        mpItens.push({ id: jogo.id, title: 'Ingresso - Monsoon FC x ' + jogo.adversario, quantity: item.quantidade, unit_price: jogo.preco, currency_id: 'BRL' });
        itensPedido.push({ ...item, preco_unit: jogo.preco, nome: 'Monsoon FC x ' + jogo.adversario });
      }
    }

    let frete = 0;
    if (entrega?.tipo === 'entrega') {
      frete = 25.00;
      mpItens.push({ id: 'frete', title: 'Frete', quantity: 1, unit_price: frete, currency_id: 'BRL' });
    }

    const pedidoId = uuidv4();
    const preference = new Preference(mpClient);
    const prefData = await preference.create({ body: {
      items: mpItens,
      payer: { name: cliente.nome, email: cliente.email },
      external_reference: pedidoId,
      back_urls: {
        success: process.env.BASE_URL + '/pagamento/sucesso?pedido=' + pedidoId,
        failure: process.env.BASE_URL + '/pagamento/falha?pedido=' + pedidoId,
        pending: process.env.BASE_URL + '/pagamento/pendente?pedido=' + pedidoId,
      },
      auto_return: 'approved',
      statement_descriptor: 'MONSOON FC',
      notification_url: process.env.BASE_URL + '/api/webhook',
    }});

    const pedido = { id: pedidoId, created_at: new Date().toISOString(), status: 'pendente', cliente, entrega, itens: itensPedido, frete, total: mpItens.reduce((a, i) => a + i.unit_price * i.quantity, 0), mp_preference_id: prefData.id, mp_payment_id: null };
    db.pedidos.push(pedido);
    await writeDB(db);
    res.json({ pedido_id: pedidoId, checkout_url: prefData.init_point });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Webhook MP
app.post('/api/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);
    const payment = new Payment(mpClient);
    const pagamento = await payment.get({ id: data.id });
    const db = await readDB();
    const idx = db.pedidos.findIndex(p => p.id === pagamento.external_reference);
    if (idx === -1) return res.sendStatus(200);
    const pedido = db.pedidos[idx];
    if (pagamento.status === 'approved') {
      pedido.status = 'pago';
      pedido.mp_payment_id = pagamento.id;
      for (const item of pedido.itens) {
        if (item.tipo === 'camiseta') { const p = db.produtos.find(x => x.id === item.id); if (p) p.estoque[item.tamanho] = Math.max(0, p.estoque[item.tamanho] - item.quantidade); }
        else if (item.tipo === 'ingresso') { const j = db.jogos.find(x => x.id === item.id); if (j) j.ingressos_disponiveis = Math.max(0, j.ingressos_disponiveis - item.quantidade); }
      }
    } else if (['cancelled','rejected'].includes(pagamento.status)) { pedido.status = pagamento.status === 'cancelled' ? 'cancelado' : 'recusado'; }
    db.pedidos[idx] = pedido;
    await writeDB(db);
    res.sendStatus(200);
  } catch (err) { console.error(err); res.sendStatus(500); }
});

// Paginas retorno
function paginaRetorno(titulo, msg, cor) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title><style>body{font-family:sans-serif;background:#080808;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}div{background:#111;border:1px solid #222;border-radius:16px;padding:3rem;max-width:480px}img{width:80px;margin-bottom:1rem}h1{color:${cor};margin-bottom:1rem}p{color:#aaa;margin-bottom:2rem}a{background:#c9a84c;color:#000;padding:.8rem 2rem;border-radius:8px;text-decoration:none;font-weight:700}</style></head><body><div><img src="https://monsoonfc.github.io/monsoon-fc-site/static/img/logo.png"><h1>${titulo}</h1><p>${msg}</p><a href="https://monsoonfc.github.io/monsoon-fc-site/loja/">Voltar a loja</a></div></body></html>`;
}
app.get('/pagamento/sucesso', (req, res) => res.send(paginaRetorno('Pagamento aprovado!', 'Obrigado! Seu pedido foi confirmado.', '#2d6a4f')));
app.get('/pagamento/falha', (req, res) => res.send(paginaRetorno('Pagamento nao aprovado', 'Houve um problema. Tente novamente.', '#c1121f')));
app.get('/pagamento/pendente', (req, res) => res.send(paginaRetorno('Pagamento pendente', 'Seu pagamento esta sendo processado.', '#e9c46a')));

// Admin
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ erro: 'Nao autorizado' });
  next();
}
app.get('/api/admin/pedidos', adminAuth, async (req, res) => { const db = await readDB(); res.json(db.pedidos.sort((a,b) => new Date(b.created_at) - new Date(a.created_at))); });
app.get('/api/admin/produtos', adminAuth, async (req, res) => { const db = await readDB(); res.json(db.produtos); });
app.put('/api/admin/produtos/:id', adminAuth, async (req, res) => { const db = await readDB(); const idx = db.produtos.findIndex(p => p.id === req.params.id); if (idx===-1) return res.status(404).json({erro:'nao encontrado'}); db.produtos[idx]={...db.produtos[idx],...req.body}; await writeDB(db); res.json(db.produtos[idx]); });
app.post('/api/admin/produtos', adminAuth, async (req, res) => { const db = await readDB(); const novo={id:uuidv4(),ativo:true,...req.body}; db.produtos.push(novo); await writeDB(db); res.json(novo); });
app.post('/api/admin/jogos', adminAuth, async (req, res) => { const db = await readDB(); const novo={id:uuidv4(),ativo:true,...req.body}; db.jogos.push(novo); await writeDB(db); res.json(novo); });
app.put('/api/admin/jogos/:id', adminAuth, async (req, res) => { const db = await readDB(); const idx = db.jogos.findIndex(j => j.id === req.params.id); if (idx===-1) return res.status(404).json({erro:'nao encontrado'}); db.jogos[idx]={...db.jogos[idx],...req.body}; await writeDB(db); res.json(db.jogos[idx]); });

app.listen(PORT, () => console.log('Monsoon Loja rodando na porta ' + PORT));
