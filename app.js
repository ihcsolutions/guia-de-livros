// ============================================================
// Guia de Livros — Versão 4.0
// Tavily + Cloudflare AI Search + Animação de espera
// © Ihcsolutions
// ============================================================

const WORKER_URL = "https://guia-de-livros-brain.ihcsolutions-contato.workers.dev";
const STORAGE_KEY = "guia_livros_historico_v2";
const APP_VERSION = "4.0";

// ---------- Critérios visíveis ----------
const CRITERIOS_VISIVEIS = [
  { key: "Violência", icon: "⚔️", label: "Violência" },
  { key: "Linguagem", icon: "🗣️", label: "Linguagem" },
  { key: "Identidade de Gênero", icon: "🌈", label: "Identidade de Gênero" }
];

// ---------- Critérios adicionais ----------
const CRITERIOS_ADICIONAIS = [
  { key: "Sexo", icon: "💞", label: "Sexo" },
  { key: "Medo/Terror", icon: "😨", label: "Medo / Terror" },
  { key: "Morte", icon: "☠️", label: "Morte" },
  { key: "Bullying", icon: "😔", label: "Bullying" },
  { key: "Respeito aos adultos", icon: "👨‍👩‍👧", label: "Respeito aos adultos" },
  { key: "Respeito à autoridade", icon: "🏛️", label: "Respeito à autoridade" },
  { key: "Respeito aos professores", icon: "🎓", label: "Respeito aos professores" },
  { key: "Obediência", icon: "📏", label: "Obediência" },
  { key: "Ocultismo", icon: "🔮", label: "Ocultismo" },
  { key: "Oposição ao cristianismo", icon: "⛪", label: "Oposição ao cristianismo" }
];

// ---------- Rótulos de Religião ----------
const RELIGIAO_LABELS = {
  sem_conteudo:      { icon: "⚪", texto: "Sem conteúdo religioso",    classe: "sem" },
  cristao:           { icon: "✝️", texto: "Cristão explícito",          classe: "cristao" },
  outra:             { icon: "📖", texto: "Outra religião",             classe: "outra" },
  ocultismo:         { icon: "🔮", texto: "Ocultismo / misticismo",     classe: "oculto" },
  ambiguo:           { icon: "⚠️", texto: "Ambíguo / espiritualista",   classe: "ambiguo" },
  nao_identificado:  { icon: "⚪", texto: "Não identificado",           classe: "nao-ident" }
};

// ---------- Helpers ----------
function badgeClass(nivel){
  const map = {
    tranquilo: "tranquilo",
    atencao: "atencao",
    sensivel: "sensivel",
    forte: "forte",
    cristao: "cristao",
    nao_identificado: "nao-ident"
  };
  return map[nivel] || "nao-ident";
}
function badgeLabel(nivel){
  const map = {
    tranquilo: "🟢 Tranquilo",
    atencao:   "🟡 Atenção",
    sensivel:  "🟠 Sensível",
    forte:     "🔴 Forte",
    cristao:   "✝️ Cristão explícito",
    nao_identificado: "⚪ Não identificado"
  };
  return map[nivel] || nivel;
}
function esc(str){
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}
function normalizar(str){
  return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// ---------- Navegação ----------
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- Histórico ----------
function getHistorico(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function salvarHistorico(lista){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lista));
}
function adicionarAoHistorico(analise){
  const lista = getHistorico();
  const filtrado = lista.filter(l =>
    normalizar(l.titulo) !== normalizar(analise.titulo) ||
    normalizar(l.autor)  !== normalizar(analise.autor)
  );
  filtrado.unshift({ ...analise, consultadoEm: new Date().toISOString() });
  salvarHistorico(filtrado);
}
function removerDoHistorico(titulo, autor){
  const lista = getHistorico().filter(l =>
    !(normalizar(l.titulo) === normalizar(titulo) && normalizar(l.autor) === normalizar(autor))
  );
  salvarHistorico(lista);
  renderHistorico();
  renderRanking();
}

// ---------- Render: Análise ----------
function renderAnalise(a){
  const box = document.getElementById("resultado");
  box.classList.remove("hidden");

  const capa = a.capa
    ? `<img src="${esc(a.capa)}" alt="Capa" onerror="this.style.display='none'">`
    : "📖";

  const criterios = a.criterios || {};
  const fontesPorCriterio = a.fontesPorCriterio || {};

  const conf = a.confiabilidade || "moderada";
  const confTexto = {
    alta: "🟢 Confiabilidade alta",
    moderada: "🟡 Confiabilidade moderada",
    baixa: "🔴 Confiabilidade baixa"
  }[conf] || "🟡 Confiabilidade moderada";

  const rel = a.religiao || { tipo: "nao_identificado", descricao: "" };
  const relLabel = RELIGIAO_LABELS[rel.tipo] || RELIGIAO_LABELS.nao_identificado;

  function renderCrit(c){
    const nivel = criterios[c.key] || "nao_identificado";
    const fonte = fontesPorCriterio[c.key];
    return `
      <div class="crit-item">
        <div class="crit-main">
          <span class="label">${c.icon} ${esc(c.label)}</span>
          <span class="badge ${badgeClass(nivel)}">${badgeLabel(nivel)}</span>
        </div>
        ${fonte ? `<div class="crit-fonte">📎 ${esc(fonte)}</div>` : ""}
      </div>`;
  }

  const visiveisHTML = CRITERIOS_VISIVEIS.map(renderCrit).join("");

  const religiaoHTML = `
    <div class="crit-item">
      <div class="crit-main">
        <span class="label">🙏 Religião</span>
        <span class="tag-religiao ${relLabel.classe}">${relLabel.icon} ${esc(relLabel.texto)}</span>
      </div>
      ${rel.descricao ? `<div class="crit-fonte">${esc(rel.descricao)}</div>` : ""}
      ${rel.fonte ? `<div class="crit-fonte">📎 ${esc(rel.fonte)}</div>` : ""}
    </div>
  `;

  const adicionaisHTML = CRITERIOS_ADICIONAIS.map(renderCrit).join("");

  const fontesHTML = (a.fontes || []).length
    ? `<p class="fontes"><strong>Fontes consultadas:</strong> ${
        a.fontes.map(f => f.url
          ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.nome)}</a>`
          : esc(f.nome)
        ).join(" · ")
      }</p>`
    : "";

  box.innerHTML = `
    <div class="card" style="--accent: var(--violet);">
      <div class="confiabilidade ${conf}">${confTexto}</div>
      <div class="book-header">
        <div class="cover">${capa}</div>
        <div class="book-info">
          <h3>${esc(a.titulo)}</h3>
          <p class="autor">${esc(a.autor || "Autor não identificado")}</p>
          <div class="meta-line">
            ${a.editora && a.editora !== "Desconhecido" ? `<span>📕 ${esc(a.editora)}</span>` : ""}
            ${a.ano ? `<span>📅 ${esc(a.ano)}</span>` : ""}
            ${a.paginas ? `<span>📄 ${esc(a.paginas)} págs.</span>` : ""}
          </div>
          ${a.faixaEtaria ? `<span class="age-line">👦 Faixa etária: ${esc(a.faixaEtaria)}</span>` : ""}
          <div class="score-box">
            <div class="score-num">${a.nota ?? "—"}<small>/10</small></div>
            <div class="verdict-text ${badgeClass(a.vereditoNivel)}">${esc(a.veredito || "")}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="--accent: var(--coral);">
      <h4 class="section-title">⚠️ Conteúdo sensível</h4>
      <div class="crit-list">
        ${visiveisHTML}
        ${religiaoHTML}
      </div>

      <button class="toggle-btn" id="btn-toggle" type="button">
        <span class="arrow">▸</span>
        <span class="toggle-text">Saiba mais (${CRITERIOS_ADICIONAIS.length} critérios adicionais)</span>
      </button>
      <div class="hidden-criteria" id="hidden-criteria">
        ${adicionaisHTML}
      </div>
    </div>

    <div class="card" style="--accent: var(--mint);">
      <h4 class="section-title">🧭 Conclusão</h4>
      <p class="conclusao">${esc(a.conclusao || "")}</p>
      ${fontesHTML}
    </div>
  `;

  const toggleBtn = document.getElementById("btn-toggle");
  const hiddenDiv = document.getElementById("hidden-criteria");
  const toggleText = toggleBtn.querySelector(".toggle-text");
  toggleBtn.addEventListener("click", () => {
    toggleBtn.classList.toggle("open");
    hiddenDiv.classList.toggle("open");
    const aberto = toggleBtn.classList.contains("open");
    toggleText.textContent = aberto
      ? "Ver menos"
      : `Saiba mais (${CRITERIOS_ADICIONAIS.length} critérios adicionais)`;
  });

  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Pesquisar ----------
document.getElementById("btn-analisar").addEventListener("click", async () => {
  const inputTitulo = document.getElementById("input-titulo");
  const inputAutor  = document.getElementById("input-autor");
  const titulo = inputTitulo.value.trim();
  const autor  = inputAutor.value.trim();
  const status = document.getElementById("search-status");
  const btn    = document.getElementById("btn-analisar");

  if (!titulo){
    status.textContent = "⚠️ Digite o nome do livro.";
    return;
  }

  // --- Animação de espera com etapas ---
  const etapas = [
    "🔎 Buscando o livro...",
    "📚 Procurando resenhas e sinopses...",
    "🧠 Lendo avaliações e analisando critérios...",
    "✍️ Preparando seu relatório final...",
    "📊 Organizando os resultados..."
  ];
  let etapaAtual = 0;
  status.innerHTML = `<span class="loading-etapa">${etapas[0]}</span>`;
  const ticker = setInterval(() => {
    etapaAtual = (etapaAtual + 1) % etapas.length;
    status.innerHTML = `<span class="loading-etapa">${etapas[etapaAtual]}</span>`;
  }, 6000);

  btn.disabled = true;

  try {
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titulo, autor })
    });
    if (!resp.ok) throw new Error("Erro na análise: " + resp.status);
    const analise = await resp.json();
    if (analise.erro) throw new Error(analise.erro);

    renderAnalise(analise);
    adicionarAoHistorico(analise);
    renderHistorico();
    renderRanking();

    inputTitulo.value = "";
    inputAutor.value = "";

    status.textContent = "✅ Análise concluída.";
  } catch (err){
    console.error(err);
    status.textContent = "❌ " + err.message;
  } finally {
    clearInterval(ticker);
    btn.disabled = false;
  }
});

// ---------- Histórico: render ----------
function renderHistorico(){
  const lista = getHistorico();
  const el = document.getElementById("lista-historico");

  if (!lista.length){
    el.innerHTML = `<div class="empty-state">Nenhum livro consultado ainda.<br>Vá em <strong>Pesquisar</strong> para começar.</div>`;
    return;
  }

  el.innerHTML = lista.map(l => `
    <div class="livro-item">
      <div class="info">
        <h4>${esc(l.titulo)}</h4>
        <p>${esc(l.autor || "")} · consultado em ${new Date(l.consultadoEm).toLocaleDateString("pt-BR")}</p>
        <div class="meta-inline">
          <span class="badge ${badgeClass(l.vereditoNivel)}">${badgeLabel(l.vereditoNivel)}</span>
          <span style="color: var(--ink); font-weight:700;">⭐ ${l.nota ?? "—"}/10</span>
          ${l.faixaEtaria ? `<span style="color: var(--ink-dim);">👦 ${esc(l.faixaEtaria)}</span>` : ""}
        </div>
      </div>
      <div class="acoes">
        <button class="icon-btn" title="Abrir análise"
          onclick='abrirDoHistorico(${JSON.stringify(l.titulo)},${JSON.stringify(l.autor || "")})'>📖</button>
        <button class="icon-btn" title="Excluir"
          onclick='removerDoHistorico(${JSON.stringify(l.titulo)},${JSON.stringify(l.autor || "")})'>🗑️</button>
      </div>
    </div>
  `).join("");
}

function abrirDoHistorico(titulo, autor){
  const item = getHistorico().find(l => l.titulo === titulo && l.autor === autor);
  if (!item) return;
  document.querySelector('.tab[data-tab="pesquisar"]').click();
  renderAnalise(item);
}

document.getElementById("btn-limpar-historico").addEventListener("click", () => {
  if (confirm("Apagar todo o histórico?")){
    localStorage.removeItem(STORAGE_KEY);
    renderHistorico();
    renderRanking();
  }
});

// ---------- Ranking ----------
function compatibilidadeIdade(idade, faixa){
  if (!faixa) return { texto: "Faixa desconhecida", nivel: "atencao", score: 0 };
  const nums = String(faixa).match(/\d+/g);
  if (!nums) return { texto: "Faixa desconhecida", nivel: "atencao", score: 0 };
  const min = parseInt(nums[0], 10);
  const max = nums[1] ? parseInt(nums[1], 10) : min + 4;

  if (idade < min - 1) return { texto: "🔴 Acima da idade", nivel: "forte", score: -3 };
  if (idade < min)     return { texto: "🟡 Um pouco acima", nivel: "sensivel", score: -1 };
  if (idade > max + 2) return { texto: "🟡 Pode ser infantil", nivel: "atencao", score: -1 };
  return { texto: "🟢 Muito compatível", nivel: "tranquilo", score: 2 };
}

function renderRanking(){
  const idade = parseInt(document.getElementById("input-idade").value, 10) || 9;
  const ordem = document.getElementById("select-ordem").value;
  const semAlertas = document.getElementById("filtro-sem-alertas").checked;

  let lista = getHistorico();

  if (semAlertas){
    lista = lista.filter(l => l.vereditoNivel === "tranquilo" || l.vereditoNivel === "cristao");
  }

  lista = lista.map(l => {
    const comp = compatibilidadeIdade(idade, l.faixaEtaria);
    const recomendacao =
      ((l.nota || 0) * 0.5) +
      ((l.valores || 0) * 0.3) +
      (comp.score * 1.0);
    return { ...l, _comp: comp, _recomendacao: recomendacao };
  });

  const sorters = {
    recomendacao: (a, b) => b._recomendacao - a._recomendacao,
    qualidade:   (a, b) => (b.nota || 0) - (a.nota || 0),
    valores:     (a, b) => (b.valores || 0) - (a.valores || 0),
    sensivel:    (a, b) => (b.notaSensivel || 0) - (a.notaSensivel || 0),
    cristao:     (a, b) =>
      (b.vereditoNivel === "cristao" ? 1 : 0) -
      (a.vereditoNivel === "cristao" ? 1 : 0)
  };
  lista.sort(sorters[ordem] || sorters.recomendacao);

  const el = document.getElementById("lista-ranking");
  if (!lista.length){
    el.innerHTML = `<div class="empty-state">Nenhum livro no histórico para ranquear.</div>`;
    return;
  }

  el.innerHTML = lista.map((l, i) => {
    let posClass = "other", posText = `${i + 1}º`;
    if (i === 0){ posClass = "gold";   posText = "🥇"; }
    else if (i === 1){ posClass = "silver"; posText = "🥈"; }
    else if (i === 2){ posClass = "bronze"; posText = "🥉"; }

    return `
      <div class="rank-item">
        <div class="rank-pos ${posClass}">${posText}</div>
        <div class="rank-body">
          <h4>${esc(l.titulo)}</h4>
          <p class="autor">${esc(l.autor || "")}</p>
          <div class="meta">
            <span style="color: var(--ink); font-weight:700;">⭐ ${l.nota ?? "—"}/10</span>
            <span>👦 ${esc(l.faixaEtaria || "?")}</span>
            <span class="badge ${badgeClass(l._comp.nivel)}">${l._comp.texto}</span>
            <span class="badge ${badgeClass(l.vereditoNivel)}">${badgeLabel(l.vereditoNivel)}</span>
          </div>
        </div>
        <button class="icon-btn" title="Abrir análise"
          onclick='abrirDoHistorico(${JSON.stringify(l.titulo)},${JSON.stringify(l.autor || "")})'>📖</button>
      </div>
    `;
  }).join("");
}

document.getElementById("input-idade").addEventListener("input", renderRanking);
document.getElementById("select-ordem").addEventListener("change", renderRanking);
document.getElementById("filtro-sem-alertas").addEventListener("change", renderRanking);

// ---------- Init ----------
renderHistorico();
renderRanking();

// ---------- Footer: versão e ano ----------
(function(){
  const elVer = document.getElementById("app-version");
  if (elVer) elVer.textContent = APP_VERSION;

  const elYear = document.getElementById("copy-year");
  if (elYear) elYear.textContent = new Date().getFullYear();
})();
