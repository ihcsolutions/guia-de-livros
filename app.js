// ============================================================
// Guia de Livros — V1
// Backend: https://guia-de-livros-brain.ihcsolutions-contato.workers.dev
// ============================================================

const WORKER_URL = "https://guia-de-livros-brain.ihcsolutions-contato.workers.dev";
const STORAGE_KEY = "guia_livros_historico_v1";

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
function getHistorico() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function salvarHistorico(lista) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lista));
}
function adicionarAoHistorico(analise) {
  const lista = getHistorico();
  const filtrado = lista.filter(l =>
    !(l.titulo === analise.titulo && l.autor === analise.autor)
  );
  filtrado.unshift({ ...analise, consultadoEm: new Date().toISOString() });
  salvarHistorico(filtrado);
}
function removerDoHistorico(titulo, autor) {
  const lista = getHistorico().filter(l =>
    !(l.titulo === titulo && l.autor === autor)
  );
  salvarHistorico(lista);
  renderHistorico();
  renderRanking();
}

// ---------- Helpers ----------
function badgeClass(nivel) {
  const map = {
    tranquilo: "tranquilo",
    atencao: "atencao",
    sensivel: "sensivel",
    forte: "forte",
    cristao: "cristao"
  };
  return map[nivel] || "tranquilo";
}
function badgeLabel(nivel) {
  const map = {
    tranquilo: "🟢 Tranquilo",
    atencao: "🟡 Atenção",
    sensivel: "🟠 Sensível",
    forte: "🔴 Forte",
    cristao: "✝️ Cristão explícito"
  };
  return map[nivel] || nivel;
}

// ---------- Render: análise individual ----------
function renderAnalise(a) {
  const box = document.getElementById("resultado");
  box.classList.remove("hidden");

  const capa = a.capa
    ? `<img src="${a.capa}" alt="Capa" onerror="this.parentNode.innerHTML='📖'">`
    : "📖";

  const vereditoCor = {
    tranquilo: "var(--c-tranquilo)",
    atencao: "var(--c-atencao)",
    sensivel: "var(--c-sensivel)",
    forte: "var(--c-forte)",
    cristao: "var(--c-cristao)"
  }[a.vereditoNivel] || "var(--verde)";

  const criteriosHTML = Object.entries(a.criterios || {}).map(([nome, nivel]) =>
    `<div class="crit-item">
       <span>${nome}</span>
       <span class="badge ${badgeClass(nivel)}">${badgeLabel(nivel)}</span>
     </div>`
  ).join("");

  const fontesHTML = (a.fontes || []).length
    ? `<p class="fontes"><strong>Fontes:</strong> ${
        a.fontes.map(f => f.url ? `<a href="${f.url}" target="_blank">${f.nome}</a>` : f.nome).join(" · ")
      }</p>`
    : "";

  box.innerHTML = `
    <div class="card">
      <div class="book-header">
        <div class="book-cover">${capa}</div>
        <div class="book-info">
          <h3>${a.titulo}</h3>
          <p class="autor">${a.autor || "Autor não identificado"}</p>
          <div class="meta-line">
            ${a.editora && a.editora !== "Desconhecido" ? `<span>📕 ${a.editora}</span>` : ""}
            ${a.ano ? `<span>📅 ${a.ano}</span>` : ""}
            ${a.paginas ? `<span>📄 ${a.paginas} págs.</span>` : ""}
          </div>
          <div class="meta-line">
            <span>👦 Faixa etária: <strong>${a.faixaEtaria || "não identificada"}</strong></span>
          </div>
          <div class="veredito-box">
            <div class="nota-grande">${(a.nota ?? "—")}<small>/10</small></div>
            <div class="veredito-text" style="color:${vereditoCor}">
              ${a.veredito || ""}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h4 class="section-title">⚠️ Conteúdo sensível e comportamento</h4>
      <div class="crit-list">${criteriosHTML}</div>
    </div>

    <div class="card">
      <h4 class="section-title">🧭 Conclusão</h4>
      <p class="conclusao">${a.conclusao || ""}</p>
      ${fontesHTML}
    </div>
  `;

  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Pesquisar ----------
document.getElementById("btn-analisar").addEventListener("click", async () => {
  const titulo = document.getElementById("input-titulo").value.trim();
  const autor = document.getElementById("input-autor").value.trim();
  const status = document.getElementById("search-status");
  const btn = document.getElementById("btn-analisar");

  if (!titulo) {
    status.textContent = "⚠️ Digite o nome do livro.";
    return;
  }

  btn.disabled = true;
  status.textContent = "🔎 Buscando informações e analisando... (pode levar até 20s)";

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

    status.textContent = "✅ Análise concluída.";
  } catch (err) {
    console.error(err);
    status.textContent = "❌ " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Histórico ----------
function renderHistorico() {
  const lista = getHistorico();
  const el = document.getElementById("lista-historico");

  if (!lista.length) {
    el.innerHTML = `<div class="empty-state">Nenhum livro consultado ainda.</div>`;
    return;
  }

  el.innerHTML = lista.map(l => `
    <div class="livro-item">
      <div class="info">
        <h4>${l.titulo}</h4>
        <p>${l.autor || ""} · consultado em ${new Date(l.consultadoEm).toLocaleDateString("pt-BR")}</p>
        <p style="margin-top:6px">
          ⭐ ${l.nota ?? "—"}/10 · 👦 ${l.faixaEtaria || "?"} · ${badgeLabel(l.vereditoNivel || "tranquilo")}
        </p>
      </div>
      <div class="acoes">
        <button class="icon-btn" onclick='abrirDoHistorico(${JSON.stringify(l.titulo)},${JSON.stringify(l.autor || "")})'>📖</button>
        <button class="icon-btn" onclick='removerDoHistorico(${JSON.stringify(l.titulo)},${JSON.stringify(l.autor || "")})'>🗑️</button>
      </div>
    </div>
  `).join("");
}

function abrirDoHistorico(titulo, autor) {
  const item = getHistorico().find(l => l.titulo === titulo && l.autor === autor);
  if (!item) return;
  document.querySelector('.tab[data-tab="pesquisar"]').click();
  renderAnalise(item);
}

document.getElementById("btn-limpar-historico").addEventListener("click", () => {
  if (confirm("Apagar todo o histórico?")) {
    localStorage.removeItem(STORAGE_KEY);
    renderHistorico();
    renderRanking();
  }
});

// ---------- Ranking ----------
function compatibilidadeIdade(idade, faixa) {
  if (!faixa) return { texto: "Faixa desconhecida", nivel: "atencao", score: 0 };

  const nums = (faixa.match(/\d+/g) || []).map(Number);
  if (!nums.length) return { texto: "Faixa desconhecida", nivel: "atencao", score: 0 };

  const min = nums[0];
  const max = nums[1] ?? min + 4;

  if (idade < min - 1) return { texto: "🔴 Acima da idade", nivel: "forte", score: -3 };
  if (idade < min)     return { texto: "🟡 Um pouco acima", nivel: "sensivel", score: -1 };
  if (idade > max + 2) return { texto: "🟡 Pode ser infantil", nivel: "atencao", score: -1 };
  return { texto: "🟢 Muito compatível", nivel: "tranquilo", score: 2 };
}

function renderRanking() {
  const idade = parseInt(document.getElementById("input-idade").value) || 9;
  const ordem = document.getElementById("select-ordem").value;
  const semAlertas = document.getElementById("filtro-sem-alertas").checked;

  let lista = getHistorico();

  if (semAlertas) {
    lista = lista.filter(l => (l.vereditoNivel === "tranquilo" || l.vereditoNivel === "cristao"));
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
    cristao:     (a, b) => (b.vereditoNivel === "cristao" ? 1 : 0) - (a.vereditoNivel === "cristao" ? 1 : 0)
  };
  lista.sort(sorters[ordem] || sorters.recomendacao);

  const el = document.getElementById("lista-ranking");
  if (!lista.length) {
    el.innerHTML = `<div class="empty-state">Nenhum livro no histórico para ranquear.</div>`;
    return;
  }

  el.innerHTML = lista.map((l, i) => {
    const medalha = ["🥇","🥈","🥉"][i] || `${i + 1}º`;
    return `
      <div class="rank-item">
        <div class="rank-pos">${medalha}</div>
        <div class="rank-body">
          <h4>${l.titulo}</h4>
          <p style="font-size:13px;color:rgba(0,0,0,0.6)">${l.autor || ""}</p>
          <div class="meta">
            <span>⭐ ${l.nota ?? "—"}/10</span>
            <span>👦 ${l.faixaEtaria || "?"}</span>
            <span class="compat-tag badge ${badgeClass(l._comp.nivel)}">${l._comp.texto}</span>
            <span>${badgeLabel(l.vereditoNivel || "tranquilo")}</span>
          </div>
        </div>
        <button class="icon-btn" onclick='abrirDoHistorico(${JSON.stringify(l.titulo)},${JSON.stringify(l.autor || "")})'>📖</button>
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
