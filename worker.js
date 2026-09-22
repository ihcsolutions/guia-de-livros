// ============================================================
// Cloudflare Worker — Guia de Livros v5.4.1
// Groq + Fallback Gemini + Fontes prioritárias + Confiabilidade
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Origin",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const CACHE_TTL = 60 * 60 * 24 * 30;
const VERSAO_PROMPT = "v5.4.1";

const PROVEDORES = [
  {
    nome: "groq",
    tipo: "openai",
    ativo: true,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    envKey: "GROQ_API_KEY",
    maxTokens: 2048
  },
  {
    nome: "gemini-2.5-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-2.5-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 2048
  },
  {
    nome: "gemini-2.5-flash-lite",
    tipo: "gemini",
    ativo: true,
    model: "gemini-2.5-flash-lite",
    envKey: "GEMINI_API_KEY",
    maxTokens: 2048
  },
  {
    nome: "gemini-2.0-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-2.0-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 2048
  },
  {
    nome: "gemini-1.5-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-1.5-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 2048
  }
];

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== "POST") return json({ erro: "Método não permitido. Use POST." }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ erro: "JSON inválido." }, 400); }

    const { titulo, autor } = body;
    if (!titulo || typeof titulo !== "string") return json({ erro: "Informe o título do livro." }, 400);

    try {
      let meta = await buscarGoogleBooks(titulo, autor);
      const olData = await buscarOpenLibrary(titulo, autor);
      if (!meta && olData) meta = olData;

      let isbn = extrairISBN(meta) || olData?.isbn || null;

      if (isbn && env.CACHE_KV) {
        try {
          const cached = await env.CACHE_KV.get(`isbn:${isbn}`, { type: "json" });
          if (cached && cached._versao_prompt === VERSAO_PROMPT) {
            console.log(`Cache HIT para ISBN ${isbn} (versão ${VERSAO_PROMPT})`);
            return json({ ...cached, _cache: "hit" });
          }
          if (cached) {
            console.log(`Cache IGNORADO para ISBN ${isbn}: versão ${cached._versao_prompt || "antiga"} ≠ ${VERSAO_PROMPT}`);
          }
        } catch (e) {
          console.error("Cache GET falhou:", e.message);
        }
      }

      const fontesWeb = await buscarFontes(titulo, autor, env);
      console.log(`Fontes encontradas: ${fontesWeb.length} (Tavily + LangSearch)`);

      let capa = meta?.capa || null;
      if (!capa) {
        try {
          capa = await montarCascataCapa(titulo, autor, meta, olData, fontesWeb);
        } catch (e) {
          console.error("Cascata de capa falhou:", e.message);
          capa = null;
        }
      }

      if (fontesWeb.length > 0 && env.AI_SEARCH_API_TOKEN && env.AI_SEARCH_ACCOUNT_ID && env.AI_SEARCH_INSTANCE) {
        indexarNoAISearch(fontesWeb, env).catch(e => console.error("Indexação falhou:", e.message));
      }

      let analise;
      try {
        analise = await analisarComIA(env, titulo, autor, meta, fontesWeb);
      } catch (e) {
        console.error("IA indisponível:", e.message);
        return json({
          erro: "ia_indisponivel",
          mensagem: "A análise por IA está temporariamente indisponível. Tente novamente em alguns minutos.",
          detalhe: e.message,
          titulo: meta?.titulo || titulo,
          autor: meta?.autores?.join(", ") || autor || "",
          capa: capa || null
        }, 200);
      }

      const contagem = contarCriterios(analise.fontesPorCriterio);
      const confiabilidadeCalculada = calcularConfiabilidade(fontesWeb.length, contagem);
      const detalhe = {
        fontes_encontradas: fontesWeb.length,
        criterios_com_fonte_web: contagem.web,
        criterios_com_conhecimento_ia: contagem.ia,
        criterios_vazios: contagem.vazio,
        regra_aplicada: confiabilidadeCalculada.regra
      };

      console.log(`Confiabilidade: ${confiabilidadeCalculada.nivel} (F=${fontesWeb.length}, C_web=${contagem.web}, C_ia=${contagem.ia}, C_vazio=${contagem.vazio})`);

      analise.confiabilidade = confiabilidadeCalculada.nivel;

      const resultadoFinal = {
        ...analise,
        capa: capa || null,
        _versao_prompt: VERSAO_PROMPT,
        _confiabilidade_detalhe: detalhe
      };
      if (isbn && env.CACHE_KV) {
        try {
          await env.CACHE_KV.put(`isbn:${isbn}`, JSON.stringify(resultadoFinal), { expirationTtl: CACHE_TTL });
          console.log(`Cache SAVE para ISBN ${isbn} (versão ${VERSAO_PROMPT})`);
        } catch (e) {
          console.error("Cache PUT falhou:", e.message);
        }
      }

      return json({ ...resultadoFinal, _cache: "miss" });

    } catch (e) {
      console.error("ERRO FATAL:", e.message, e.stack);
      return json({
        erro: e.message,
        tipo: e.name || "Error",
        detalhe: (e.stack || "").split("\n").slice(0, 3).join(" | ")
      }, 500);
    }
  }
};

// ============================================================
// Contagem de critérios por origem da fonte
// ============================================================
function contarCriterios(fontesPorCriterio) {
  let web = 0, ia = 0, vazio = 0;
  for (const fonte of Object.values(fontesPorCriterio || {})) {
    const f = String(fonte || "").trim().toLowerCase();
    if (!f || f === "nao_identificado" || f === "—" || f === "-") {
      vazio++;
    } else if (f.includes("conhecimento prévio") || f.includes("conhecimento previo")) {
      ia++;
    } else if (/^\[\d+\]/.test(f)) {
      web++;
    } else {
      vazio++;
    }
  }
  return { web, ia, vazio };
}

// ============================================================
// Cálculo da confiabilidade geral
// ============================================================
function calcularConfiabilidade(F, contagem) {
  const C_web = contagem.web;

  if (F >= 10 && C_web >= 4) {
    return { nivel: "alta", regra: `alta (F=${F} >= 10 E C_web=${C_web} >= 4)` };
  }
  if (F >= 5 && C_web >= 2) {
    return { nivel: "moderada", regra: `moderada (F=${F} >= 5 E C_web=${C_web} >= 2)` };
  }
  if (F >= 10 && C_web >= 1) {
    return { nivel: "moderada", regra: `moderada (F=${F} >= 10 E C_web=${C_web} >= 1)` };
  }
  return { nivel: "baixa", regra: `baixa (F=${F}, C_web=${C_web} — não atingiu moderada)` };
}

// ============================================================
// Extrair ISBN
// ============================================================
function extrairISBN(meta){
  if (!meta) return null;
  if (meta.isbn) return meta.isbn;
  if (meta.industryIdentifiers?.length){
    const i13 = meta.industryIdentifiers.find(i => i.type === "ISBN_13");
    const i10 = meta.industryIdentifiers.find(i => i.type === "ISBN_10");
    return (i13 || i10)?.identifier || null;
  }
  return null;
}

// ============================================================
// TAVILY
// ============================================================
async function buscarTavily(titulo, autor, apiKey) {
  if (!apiKey) return [];
  try {
    const query = `"${titulo}"${autor ? ` "${autor}"` : ""} resenha análise personagens temas`;
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        include_answer: false,
        include_raw_content: true,
        max_results: 8,
        exclude_domains: [
          "instagram.com", "facebook.com", "twitter.com",
          "tiktok.com", "pinterest.com",
          "amazon.com.br", "americanas.com.br", "submarino.com.br"
        ]
      })
    });
    if (!r.ok) {
      console.error("Tavily erro:", r.status);
      return [];
    }
    const data = await r.json();
    return (data.results || []).map(item => ({
      titulo: item.title || "",
      url: item.url || "",
      conteudo: item.raw_content || item.content || ""
    }));
  } catch (e) {
    console.error("Tavily falha:", e.message);
    return [];
  }
}

// ============================================================
// LANGSEARCH
// ============================================================
async function buscarLangSearch(titulo, autor, apiKey) {
  if (!apiKey) {
    console.log("LangSearch: chave não configurada, pulando.");
    return [];
  }
  try {
    const query = `"${titulo}"${autor ? ` "${autor}"` : ""} resenha análise personagens temas`;
    const r = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        count: 15,
        freshness: "noLimit",
        contents: { text: { maxCharacters: 3000 } },
        excludeDomains: [
          "instagram.com", "facebook.com", "twitter.com",
          "tiktok.com", "pinterest.com",
          "amazon.com.br", "americanas.com.br", "submarino.com.br"
        ]
      })
    });
    if (!r.ok) {
      console.error("LangSearch erro:", r.status);
      return [];
    }
    const data = await r.json();
    const itens = data.data?.webPages?.value || [];
    return itens.map(item => ({
      titulo: item.name || "",
      url: item.url || "",
      conteudo: item.text || item.snippet || ""
    }));
  } catch (e) {
    console.error("LangSearch falha:", e.message);
    return [];
  }
}

// ============================================================
// BUSCAR FONTES
// ============================================================
async function buscarFontes(titulo, autor, env) {
  const [tavily, langsearch] = await Promise.all([
    buscarTavily(titulo, autor, env.TAVILY_API_KEY),
    buscarLangSearch(titulo, autor, env.LANGSEARCH_API_KEY)
  ]);

  const vistos = new Set();
  const resultado = [];
  for (const f of [...tavily, ...langsearch]) {
    if (f.url && !vistos.has(f.url)) {
      vistos.add(f.url);
      resultado.push(f);
    }
  }
  return resultado;
}

// ============================================================
// Extrair og:image
// ============================================================
async function extrairOgImage(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GuiaLivros/5.4.1)" }
    });
    if (!r.ok) return null;
    const html = await r.text();

    let match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (match) return match[1].replace(/&amp;/g, "&");

    match = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (match) return match[1].replace(/&amp;/g, "&");

    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// Extrair ID de URL do Google Books
// ============================================================
function extrairGoogleBooksId(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("books.google.")) return null;
    return u.searchParams.get("id") || null;
  } catch { return null; }
}

// ============================================================
// Buscar Google Books por ID
// ============================================================
async function buscarGoogleBooksPorId(id) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes/${id}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const v = data.volumeInfo || {};
    return {
      titulo: v.title,
      autores: v.authors || [],
      editora: v.publisher || null,
      ano: v.publishedDate ? v.publishedDate.slice(0, 4) : null,
      paginas: v.pageCount || null,
      sinopse: v.description || null,
      capa: extrairCapaGoogle(v.imageLinks),
      categorias: v.categories || [],
      industryIdentifiers: v.industryIdentifiers || []
    };
  } catch (e) {
    console.error("GoogleBooksPorId falhou:", e.message);
    return null;
  }
}

// ============================================================
// Testar capa
// ============================================================
async function testarCapa(url) {
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { "Range": "bytes=0-0" }
    });
    return r.ok || r.status === 206;
  } catch (e) {
    return false;
  }
}

// ============================================================
// Cascata de capa
// ============================================================
async function montarCascataCapa(titulo, autor, meta, olData, fontesWeb) {
  const tentativas = [];

  if (meta?.capa) tentativas.push({ fonte: "Google Books", url: meta.capa });

  const isbnGB = extrairISBN(meta);
  if (isbnGB) {
    tentativas.push({
      fonte: "Open Library (ISBN GB)",
      url: `https://covers.openlibrary.org/b/isbn/${isbnGB}-L.jpg?default=false`
    });
  }

  const ol = olData || await buscarOpenLibrary(titulo, autor);
  if (ol?.isbns?.length) {
    for (const isbn of ol.isbns.slice(0, 5)) {
      tentativas.push({
        fonte: `Open Library (ISBN ${isbn})`,
        url: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`
      });
    }
  }
  if (ol?.cover_i) {
    tentativas.push({
      fonte: "Open Library (cover_i)",
      url: `https://covers.openlibrary.org/b/id/${ol.cover_i}-L.jpg`
    });
  }

  const coverTitulo = await buscarCapaOpenLibraryPorTitulo(titulo);
  if (coverTitulo) tentativas.push({ fonte: "Open Library (título)", url: coverTitulo });

  if (fontesWeb?.length) {
    for (const fonte of fontesWeb.slice(0, 6)) {
      if (!fonte.url) continue;
      try {
        const og = await extrairOgImage(fonte.url);
        if (og && (og.startsWith("http://") || og.startsWith("https://"))) {
          const ogHttps = og.replace("http://", "https://");
          tentativas.push({ fonte: `og:image ${new URL(fonte.url).hostname}`, url: ogHttps });
        }
      } catch (e) { }
    }
  }

  if (fontesWeb?.length) {
    for (const fonte of fontesWeb) {
      const gbId = extrairGoogleBooksId(fonte.url);
      if (!gbId) continue;
      try {
        const gbVolume = await buscarGoogleBooksPorId(gbId);
        if (gbVolume?.capa) {
          tentativas.push({ fonte: `Google Books (ID ${gbId})`, url: gbVolume.capa });
        }
      } catch (e) { }
    }
  }

  if (ol?.isbns?.length) {
    for (const isbn of ol.isbns.slice(0, 3)) {
      tentativas.push({
        fonte: `Amazon (ISBN ${isbn})`,
        url: `https://m.media-amazon.com/images/P/${isbn.replace(/-/g, "")}.jpg`
      });
    }
  }
  if (isbnGB) {
    tentativas.push({
      fonte: `Amazon (ISBN GB ${isbnGB})`,
      url: `https://m.media-amazon.com/images/P/${isbnGB.replace(/-/g, "")}.jpg`
    });
  }

  for (const t of tentativas) {
    const ok = await testarCapa(t.url);
    if (ok) {
      console.log(`✅ Capa via ${t.fonte}`);
      return t.url;
    }
  }

  console.log(`❌ Nenhuma capa para "${titulo}"`);
  return null;
}

// ============================================================
// Open Library Search API
// ============================================================
async function buscarCapaOpenLibraryPorTitulo(titulo) {
  const norm = normalizar(titulo);
  const semStop = norm.split(" ")
    .filter(p => p && !["a","o","as","os","de","da","do","das","dos","e","em","the","of","and"].includes(p))
    .join(" ");

  const queries = [`title:"${titulo}"`, titulo, semStop];

  for (const q of queries) {
    try {
      const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=20`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();

      for (const doc of data.docs || []) {
        if (doc.cover_i) {
          return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        }
      }
    } catch (e) { }
  }
  return null;
}

// ============================================================
// Google Books
// ============================================================
async function buscarGoogleBooks(titulo, autor) {
  try {
    const queries = [];
    if (autor) queries.push(`intitle:${titulo}+inauthor:${autor}`);
    queries.push(`intitle:${titulo}`);
    queries.push(`${titulo}${autor ? " " + autor : ""}`);

    const todosItens = [];
    for (const q of queries) {
      try {
        const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        if (data.items?.length) todosItens.push(...data.items);
        const comCapaEscore = todosItens.filter(it => {
          const v = it.volumeInfo || {};
          return (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail) &&
                 similaridade(titulo, v.title || "") >= 0.4;
        });
        if (comCapaEscore.length >= 2) break;
      } catch (e) { }
    }

    if (!todosItens.length) return null;

    const scored = todosItens.map(it => {
      const v = it.volumeInfo || {};
      const score = similaridade(titulo, v.title || "");
      const temCapa = !!(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || v.imageLinks?.large || v.imageLinks?.medium);
      return { v, score, temCapa };
    });

    scored.sort((a, b) => {
      const aPass = a.score >= 0.4;
      const bPass = b.score >= 0.4;
      if (aPass !== bPass) return bPass - aPass;
      if (a.temCapa !== b.temCapa) return b.temCapa - a.temCapa;
      return b.score - a.score;
    });

    let escolhido = scored.find(s => s.score >= 0.4);
    if (!escolhido) escolhido = scored.find(s => s.score >= 0.25 && s.temCapa);
    if (!escolhido) return null;

    const v = escolhido.v;
    let capa = extrairCapaGoogle(v.imageLinks);

    return {
      titulo: v.title,
      autores: v.authors || [],
      editora: v.publisher || null,
      ano: v.publishedDate ? v.publishedDate.slice(0, 4) : null,
      paginas: v.pageCount || null,
      sinopse: v.description || null,
      capa: capa,
      categorias: v.categories || [],
      industryIdentifiers: v.industryIdentifiers || []
    };
  } catch (e) {
    console.error("GoogleBooks erro:", e.message);
    return null;
  }
}

// ============================================================
// Open Library
// ============================================================
async function buscarOpenLibrary(titulo, autor) {
  try {
    const q = encodeURIComponent(`${titulo}${autor ? " " + autor : ""}`);
    const url = `https://openlibrary.org/search.json?q=${q}&limit=15`;
    const r = await fetch(url);
    if (!r.ok) return null;

    const data = await r.json();
    if (!data.docs?.length) return null;

    const scored = data.docs.map(d => ({
      d,
      score: similaridade(titulo, d.title || ""),
      temCapa: !!d.cover_i
    }));

    scored.sort((a, b) => {
      const aPass = a.score >= 0.4;
      const bPass = b.score >= 0.4;
      if (aPass !== bPass) return bPass - aPass;
      if (a.temCapa !== b.temCapa) return b.temCapa - a.temCapa;
      return b.score - a.score;
    });

    let escolhido = scored.find(s => s.score >= 0.4);
    if (!escolhido) escolhido = scored.find(s => s.score >= 0.25 && s.temCapa);
    if (!escolhido) return null;

    const d = escolhido.d;

    let capa = null;
    if (d.cover_i) capa = `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`;
    else if (d.isbn?.length) capa = `https://covers.openlibrary.org/b/isbn/${d.isbn[0]}-L.jpg?default=false`;

    return {
      titulo: d.title,
      autores: d.author_name || [],
      editora: d.publisher?.[0] || null,
      ano: d.first_publish_year?.toString() || null,
      paginas: d.number_of_pages_median || null,
      sinopse: null,
      capa: capa,
      categorias: d.subject || [],
      isbn: d.isbn?.[0] || null,
      isbns: d.isbn || [],
      cover_i: d.cover_i || null
    };
  } catch (e) {
    console.error("OpenLibrary erro:", e.message);
    return null;
  }
}

// ============================================================
// Utilidades
// ============================================================
function normalizar(str){
  return String(str || "")
    .toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function similaridade(a, b){
  const wa = new Set(normalizar(a).split(" ").filter(Boolean));
  const wb = new Set(normalizar(b).split(" ").filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  const inter = [...wa].filter(w => wb.has(w)).length;
  const uniao = new Set([...wa, ...wb]).size;
  return inter / uniao;
}
function extrairCapaGoogle(imageLinks) {
  if (!imageLinks) return null;
  const url = imageLinks.large || imageLinks.medium || imageLinks.thumbnail || imageLinks.smallThumbnail;
  if (!url) return null;
  return url.replace("http://", "https://").replace("&zoom=1", "&zoom=2");
}

// ============================================================
// Cloudflare AI Search
// ============================================================
async function indexarNoAISearch(fontes, env) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.AI_SEARCH_ACCOUNT_ID}/ai-search/instances/${env.AI_SEARCH_INSTANCE}/items`;
  for (const fonte of fontes) {
    if (!fonte.conteudo || fonte.conteudo.length < 50) continue;
    try {
      await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.AI_SEARCH_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: fonte.conteudo.slice(0, 10000),
          metadata: { title: fonte.titulo, url: fonte.url }
        })
      });
    } catch (e) { }
  }
}

// ============================================================
// IA — análise com fallback + prompt v5.4.1
// ============================================================
async function analisarComIA(env, titulo, autor, meta, fontes) {
  const provedoresAtivos = PROVEDORES.filter(p => p.ativo && env[p.envKey]);
  if (!provedoresAtivos.length) throw new Error("Nenhum provedor de IA configurado.");

  let ultimoErro = null;
  for (const provedor of provedoresAtivos) {
    try {
      const resultado = await chamarProvedor(provedor, env, titulo, autor, meta, fontes);
      if (provedor.nome !== "groq") {
        console.log(`✅ Fallback ${provedor.nome} respondeu (Groq falhou).`);
      }
      return resultado;
    } catch (e) {
      console.warn(`Provedor ${provedor.nome} falhou: ${e.message}`);
      ultimoErro = e;
    }
  }
  throw ultimoErro || new Error("Todos os provedores de IA falharam.");
}

async function chamarProvedor(provedor, env, titulo, autor, meta, fontes) {
  const apiKey = env[provedor.envKey];

  const LIMITE_FONTES = 6;
  const LIMITE_CHARS = 600;

  const fontesReduzidas = fontes
    .filter(f => f.conteudo && f.conteudo.length > 100)
    .slice(0, LIMITE_FONTES)
    .map(f => ({
      titulo: (f.titulo || "").slice(0, 80),
      url: f.url,
      conteudo: f.conteudo.slice(0, LIMITE_CHARS)
    }));

  const metaLimpa = meta ? {
    titulo: meta.titulo,
    autores: meta.autores,
    editora: meta.editora,
    ano: meta.ano,
    sinopse: meta.sinopse ? meta.sinopse.slice(0, 600) : null
  } : null;

  const fontesTexto = fontesReduzidas.length
    ? fontesReduzidas.map((f, i) => `[${i + 1}] ${f.titulo}\nURL: ${f.url}\n${f.conteudo}`).join("\n\n")
    : "Nenhuma fonte web.";

  // ============ v5.4.1: prioridade OBRIGATÓRIA de fontes ============
  const prompt = `Analista literário cristão. Analise "${titulo}"${autor ? ` de ${autor}` : ""}.

META: ${metaLimpa ? JSON.stringify(metaLimpa) : "—"}

FONTES (${fontesReduzidas.length}):
${fontesTexto}

═══ REGRA CRÍTICA: PRIORIDADE DE FONTES ═══
Para CADA critério, siga esta ordem OBRIGATÓRIA:
  (a) Se ALGUMA fonte web acima fala do critério → cite "[N] Título" em fontesPorCriterio.
  (b) SÓ use "Conhecimento prévio" se NENHUMA fonte cobrir o critério.
  (c) Só use "nao_identificado" se nem fonte nem conhecimento cobrirem.

FONTES WEB TÊM PRIORIDADE ABSOLUTA SOBRE CONHECIMENTO PRÉVIO.
Se você recebeu fontes e marcou "Conhecimento prévio" em TODOS os critérios,
você está ERRADO — reveja quais fontes falam sobre cada critério.

EXEMPLO CERTO:
  Fonte [2] fala de amizade e coragem.
  → Respeito: tranquilo | fontesPorCriterio: "[2] Nome da fonte"

EXEMPLO ERRADO (NUNCA faça):
  Fonte [2] fala de amizade mas você escreveu "Conhecimento prévio".
  → Isso é errado. Cite a fonte.

═══ OUTRAS REGRAS ═══
1. Bullying = agressão SISTEMÁTICA. Respeito = tom geral.
2. No array "fontes" final, use APENAS URLs REAIS das fontes acima. NUNCA invente.
3. Retorne SOMENTE JSON.

CRITÉRIOS POSITIVOS (enum: tranquilo|atencao|sensivel|forte|nao_identificado):
Violência (inclui racismo, discriminação), Linguagem, Identidade de Gênero, Sexo, Medo/Terror, Morte, Bullying, Respeito, Obediência, Ocultismo.

CRITÉRIO NEGATIVO (enum: tranquilo|atencao|sensivel|forte|nao_identificado):
"Oposição ao cristianismo":
- Livro NÃO critica a fé cristã → "tranquilo"
- Livro ridiculariza ou ataca cristãos → "forte"
- Livro é neutro sobre religião → "tranquilo"

VALORES (número 0-5):
- 0 = nenhum valor positivo | 3 = valores positivos presentes (amizade, coragem) | 5 = valores cristãos explícitos.

NOTA SENSÍVEL (número 0-5):
- 0 = nenhum conteúdo sensível | 3 = moderado (alguns alertas 🟡) | 5 = forte (alertas 🔴).

RELIGIÃO (enum: sem_conteudo|cristao|outra|ocultismo|ambiguo|nao_identificado): tipo + descricao + fonte.

RETORNE JSON:
{
 "titulo":"","autor":"","editora":"","ano":"","paginas":0,
 "faixaEtaria":"","confiabilidade":"alta|moderada|baixa",
 "nota":0,"valores":0,"notaSensivel":0,
 "vereditoNivel":"tranquilo|atencao|sensivel|forte|cristao","veredito":"",
 "criterios":{"Violência":"","Linguagem":"","Identidade de Gênero":"","Sexo":"","Medo/Terror":"","Morte":"","Bullying":"","Respeito":"","Obediência":"","Ocultismo":"","Oposição ao cristianismo":""},
 "fontesPorCriterio":{"Violência":"","Linguagem":"","Identidade de Gênero":"","Sexo":"","Medo/Terror":"","Morte":"","Bullying":"","Respeito":"","Obediência":"","Ocultismo":"","Oposição ao cristianismo":""},
 "religiao":{"tipo":"","descricao":"","fonte":""},
 "conclusao":"",
 "fontes":[{"nome":"","url":""}]
}`;

  const MAX_TENTATIVAS = 3;
  const esperas = [1000, 3000, 6000];
  let fontesAtuais = fontesReduzidas;

  let ultimoErro = null;
  for (let i = 0; i < MAX_TENTATIVAS; i++) {
    const fontesTextoAtual = fontesAtuais.length
      ? fontesAtuais.map((f, idx) => `[${idx + 1}] ${f.titulo}\nURL: ${f.url}\n${f.conteudo}`).join("\n\n")
      : "Nenhuma fonte web.";

    const promptAtual = prompt.replace(
      /FONTES \(\d+\):\n[\s\S]*?\n\n═══ REGRA CRÍTICA:/,
      `FONTES (${fontesAtuais.length}):\n${fontesTextoAtual}\n\n═══ REGRA CRÍTICA:`
    );

    let url, payload, headers;

    if (provedor.tipo === "openai") {
      url = provedor.url;
      headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      };
      payload = {
        model: provedor.model,
        messages: [
          { role: "system", content: "Responda apenas em JSON válido. Siga as regras de prioridade de fontes rigorosamente." },
          { role: "user", content: promptAtual }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
        max_tokens: provedor.maxTokens
      };
    } else if (provedor.tipo === "gemini") {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${provedor.model}:generateContent?key=${apiKey}`;
      headers = { "Content-Type": "application/json" };
      payload = {
        contents: [
          { role: "user", parts: [{ text: promptAtual }] }
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: provedor.maxTokens,
          responseMimeType: "application/json"
        }
      };
    } else {
      throw new Error(`Tipo de provedor desconhecido: ${provedor.tipo}`);
    }

    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (r.status === 413) {
        const texto = await r.text();
        ultimoErro = new Error(`${provedor.nome} 413: ${texto.slice(0, 150)}`);
        console.warn(`${provedor.nome} 413 na tentativa ${i + 1}/${MAX_TENTATIVAS}. Cortando fontes para ${Math.max(2, Math.floor(fontesAtuais.length / 2))}...`);
        fontesAtuais = fontesAtuais.slice(0, Math.max(2, Math.floor(fontesAtuais.length / 2)));
        if (i < MAX_TENTATIVAS - 1) await new Promise(res => setTimeout(res, esperas[i]));
        continue;
      }

      if (r.status === 503 || r.status === 429 || r.status === 500) {
        const texto = await r.text();
        ultimoErro = new Error(`${provedor.nome} ${r.status}: ${texto.slice(0, 150)}`);
        console.warn(`${provedor.nome} ${r.status} na tentativa ${i + 1}/${MAX_TENTATIVAS}. Aguardando ${esperas[i]}ms...`);
        if (i < MAX_TENTATIVAS - 1) await new Promise(res => setTimeout(res, esperas[i]));
        continue;
      }

      if (r.status === 404 && provedor.tipo === "gemini") {
        const texto = await r.text();
        throw new Error(`${provedor.nome} 404 (modelo indisponível): ${texto.slice(0, 150)}`);
      }

      if (!r.ok) {
        const texto = await r.text();
        throw new Error(`${provedor.nome} ${r.status}: ${texto.slice(0, 200)}`);
      }

      const data = await r.json();

      let textoResposta;
      if (provedor.tipo === "openai") {
        textoResposta = data.choices?.[0]?.message?.content;
      } else if (provedor.tipo === "gemini") {
        textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text;
      }

      if (!textoResposta) throw new Error("Resposta vazia da IA.");

      try {
        const parsed = JSON.parse(textoResposta);
        parsed.fontes = sanitizarFontes(parsed.fontes, fontesReduzidas);
        parsed.valores = clamp(parsed.valores, 0, 5);
        parsed.notaSensivel = clamp(parsed.notaSensivel, 0, 5);
        if (i > 0) console.log(`✅ ${provedor.nome} respondeu na tentativa ${i + 1}/${MAX_TENTATIVAS} com ${fontesAtuais.length} fontes`);
        return parsed;
      } catch (e) {
        if (e.message.includes("sanitizar") || e.message.includes("clamp")) throw e;
        throw new Error("IA retornou conteúdo que não é JSON válido.");
      }

    } catch (e) {
      ultimoErro = e;
      if (e.message.includes("404")) throw e;
      if (!new RegExp(`${provedor.nome} (503|429|500|413)`).test(e.message)) throw e;
      if (i < MAX_TENTATIVAS - 1) await new Promise(res => setTimeout(res, esperas[i]));
    }
  }

  throw new Error(`${provedor.nome} indisponível após ${MAX_TENTATIVAS} tentativas. ${ultimoErro?.message || ""}`);
}

// ============================================================
// Sanitizar fontes — remove URLs alucinadas
// ============================================================
function sanitizarFontes(fontesIA, fontesReais) {
  if (!Array.isArray(fontesIA)) return [];
  const urlsReais = new Set(fontesReais.map(f => f.url).filter(Boolean));
  const nomesReais = new Map();
  fontesReais.forEach((f, i) => {
    nomesReais.set(`[${i + 1}] ${f.titulo}`.toLowerCase(), f.url);
    nomesReais.set(f.titulo.toLowerCase(), f.url);
  });

  return fontesIA
    .map(f => {
      if (!f) return null;
      const nomeOriginal = (f.nome || "").trim();
      const urlOriginal = (f.url || "").trim();
      const nomeLower = nomeOriginal.toLowerCase();

      if (urlOriginal && urlsReais.has(urlOriginal)) {
        return { nome: nomeOriginal, url: urlOriginal };
      }
      if (nomesReais.has(nomeLower)) {
        return { nome: nomeOriginal, url: nomesReais.get(nomeLower) };
      }
      const match = nomeOriginal.match(/^\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        if (fontesReais[idx]?.url) {
          return { nome: nomeOriginal, url: fontesReais[idx].url };
        }
      }
      return null;
    })
    .filter(Boolean);
}

// ============================================================
// clamp numérico — garante 0-5
// ============================================================
function clamp(valor, min, max) {
  const n = Number(valor);
  if (!isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}