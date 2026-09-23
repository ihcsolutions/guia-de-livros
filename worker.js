// ============================================================
// Cloudflare Worker — Guia de Livros v5.10
// Definições completas dos critérios + Groq + Gemini + cache duplo
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Origin",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const CACHE_TTL = 60 * 60 * 24 * 30;
const VERSAO_PROMPT = "v5.10";

const PROVEDORES = [
  {
    nome: "groq",
    tipo: "openai",
    ativo: true,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    envKey: "GROQ_API_KEY",
    maxTokens: 3072
  },
  {
    nome: "gemini-3.8-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-3.8-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 3072
  },
  {
    nome: "gemini-3.7-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-3.7-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 3072
  },
  {
    nome: "gemini-3.5-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-3.5-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 3072
  },
  {
    nome: "gemini-2.5-flash",
    tipo: "gemini",
    ativo: true,
    model: "gemini-2.5-flash",
    envKey: "GEMINI_API_KEY",
    maxTokens: 3072
  },
  {
    nome: "gemini-2.5-flash-lite",
    tipo: "gemini",
    ativo: true,
    model: "gemini-2.5-flash-lite",
    envKey: "GEMINI_API_KEY",
    maxTokens: 3072
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
      // ============ 0. Cache por título+autor (fallback) ============
      const chaveTitulo = gerarChaveTitulo(titulo, autor);
      if (env.CACHE_KV) {
        try {
          const cachedTitulo = await env.CACHE_KV.get(`titulo:${chaveTitulo}`, { type: "json" });
          if (cachedTitulo && cachedTitulo._versao_prompt === VERSAO_PROMPT) {
            console.log(`Cache HIT por título: "${titulo}" (versão ${VERSAO_PROMPT})`);
            return json({ ...cachedTitulo, _cache: "hit-titulo" });
          }
          if (cachedTitulo) {
            console.log(`Cache por título IGNORADO: versão ${cachedTitulo._versao_prompt || "antiga"} ≠ ${VERSAO_PROMPT}`);
          }
        } catch (e) {
          console.error("Cache GET por título falhou:", e.message);
        }
      }

      // ============ 1. Metadados ============
      let meta = await buscarGoogleBooks(titulo, autor);
      const olData = await buscarOpenLibrary(titulo, autor);
      if (!meta && olData) meta = olData;

      let isbn = extrairISBN(meta) || olData?.isbn || null;

      // ============ 2. Cache por ISBN ============
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

      // ============ 3. Fontes web ============
      const fontesWeb = await buscarFontes(titulo, autor, env);
      console.log(`Fontes encontradas: ${fontesWeb.length} (Tavily + LangSearch)`);

      // ============ 4. Cascata de capa ============
      let capa = meta?.capa || null;
      if (!capa) {
        try {
          capa = await montarCascataCapa(titulo, autor, meta, olData, fontesWeb);
        } catch (e) {
          console.error("Cascata de capa falhou:", e.message);
          capa = null;
        }
      }

      // ============ 5. Indexar no AI Search (best-effort) ============
      if (fontesWeb.length > 0 && env.AI_SEARCH_API_TOKEN && env.AI_SEARCH_ACCOUNT_ID && env.AI_SEARCH_INSTANCE) {
        indexarNoAISearch(fontesWeb, env).catch(e => console.error("Indexação falhou:", e.message));
      }

      // ============ 6. Analisar com IA ============
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

      // ============ 7. Validar campos críticos ============
      const camposFaltando = [];
      if (!analise.fontesPorCriterio) camposFaltando.push("fontesPorCriterio");
      if (!analise.religiao) camposFaltando.push("religiao");
      if (!analise.conclusao) camposFaltando.push("conclusao");
      if (camposFaltando.length > 0) {
        console.warn(`⚠️ Campos faltando no JSON do Groq: ${camposFaltando.join(", ")}`);
      }

      // ============ 8. Calcular confiabilidade ============
      let contagem;
      let usouFallback = false;
      if (analise.fontesPorCriterio && typeof analise.fontesPorCriterio === "object") {
        contagem = contarCriterios(analise.fontesPorCriterio);
      } else {
        const totalFontes = (analise.fontes || []).length;
        contagem = { web: totalFontes, ia: 0, vazio: 0 };
        usouFallback = true;
        console.warn(`⚠️ Fallback: usando fontes.length (${totalFontes}) como C_web`);
      }

      const F = fontesWeb.length;
      const confiabilidadeCalculada = calcularConfiabilidade(F, contagem, usouFallback, camposFaltando);
      const detalhe = {
        fontes_encontradas: F,
        criterios_com_fonte_web: contagem.web,
        criterios_com_conhecimento_ia: contagem.ia,
        criterios_vazios: contagem.vazio,
        usou_fallback: usouFallback,
        campos_faltando: camposFaltando,
        regra_aplicada: confiabilidadeCalculada.regra
      };

      console.log(`Confiabilidade: ${confiabilidadeCalculada.nivel} (F=${F}, C_web=${contagem.web}, fallback=${usouFallback}, faltando=[${camposFaltando.join(",")}])`);

      analise.confiabilidade = confiabilidadeCalculada.nivel;

      // ============ 9. Cache (grava nos dois formatos) ============
      const resultadoFinal = {
        ...analise,
        capa: capa || null,
        _versao_prompt: VERSAO_PROMPT,
        _confiabilidade_detalhe: detalhe
      };

      if (env.CACHE_KV) {
        if (isbn) {
          try {
            await env.CACHE_KV.put(`isbn:${isbn}`, JSON.stringify(resultadoFinal), { expirationTtl: CACHE_TTL });
            console.log(`Cache SAVE por ISBN ${isbn} (versão ${VERSAO_PROMPT})`);
          } catch (e) {
            console.error("Cache PUT por ISBN falhou:", e.message);
          }
        }
        try {
          await env.CACHE_KV.put(`titulo:${chaveTitulo}`, JSON.stringify(resultadoFinal), { expirationTtl: CACHE_TTL });
          console.log(`Cache SAVE por título: "${titulo}" (versão ${VERSAO_PROMPT})`);
        } catch (e) {
          console.error("Cache PUT por título falhou:", e.message);
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
// Gerar chave de cache a partir de título + autor
// ============================================================
function gerarChaveTitulo(titulo, autor) {
  const t = normalizar(titulo);
  const a = normalizar(autor || "");
  const base = (t + "|" + a).slice(0, 200);
  return base.replace(/[^a-z0-9|]/g, "-");
}

// ============================================================
// Contagem de critérios por origem da fonte
// ============================================================
function contarCriterios(fontesPorCriterio) {
  let web = 0, ia = 0, vazio = 0;

  if (!fontesPorCriterio || typeof fontesPorCriterio !== "object") {
    return { web: 0, ia: 0, vazio: 0 };
  }

  for (const fonte of Object.values(fontesPorCriterio)) {
    if (Array.isArray(fonte)) {
      if (fonte.length > 0) web++;
      else vazio++;
      continue;
    }
    const f = String(fonte || "").trim().toLowerCase();
    if (!f || f === "nao_identificado" || f === "—" || f === "-") {
      vazio++;
    } else if (f.includes("conhecimento prévio") || f.includes("conhecimento previo")) {
      ia++;
    } else if (/^\[\d+\]/.test(f)) {
      web++;
    } else if (f.startsWith("http")) {
      web++;
    } else {
      vazio++;
    }
  }
  return { web, ia, vazio };
}

// ============================================================
// Cálculo da confiabilidade
// ============================================================
function calcularConfiabilidade(F, contagem, usouFallback, camposFaltando) {
  const C_web = contagem.web;
  const temCamposFaltando = camposFaltando && camposFaltando.length > 0;

  if (F === 0 && C_web === 0) {
    return { nivel: "nao_confiavel", regra: `nao_confiavel (F=0 E C_web=0 — sem fontes)` };
  }

  if (!temCamposFaltando && F >= 5 && C_web >= 3) {
    return { nivel: "alta", regra: `alta (F=${F} >= 5 E C_web=${C_web} >= 3)` };
  }

  if (F >= 3 && C_web >= 2) {
    return { nivel: "moderada", regra: `moderada (F=${F} >= 3 E C_web=${C_web} >= 2${temCamposFaltando ? " — campos faltando" : ""})` };
  }

  if (F >= 1 && C_web >= 1) {
    return { nivel: "baixa", regra: `baixa (F=${F} >= 1 E C_web=${C_web} >= 1${temCamposFaltando ? " — campos faltando" : ""})` };
  }

  if (F > 0) {
    return { nivel: "baixa", regra: `baixa (F=${F} mas C_web=${C_web} — fallback de segurança)` };
  }

  return { nivel: "nao_confiavel", regra: `nao_confiavel (F=${F}, C_web=${C_web})` };
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
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GuiaLivros/5.10)" }
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
// IA — análise com fallback + prompt v5.10
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

  const LIMITE_FONTES = 4;
  const LIMITE_CHARS = 500;

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

  // ============ v5.10: definições completas dos critérios ============
  const prompt = `Analista literário cristão. Analise "${titulo}"${autor ? ` de ${autor}` : ""}.

META: ${metaLimpa ? JSON.stringify(metaLimpa) : "—"}

FONTES (${fontesReduzidas.length}):
${fontesTexto}

REGRAS CRÍTICAS:
1. Retorne SOMENTE JSON válido. A ORDEM DAS CHAVES IMPORTA — siga exatamente.

2. fontesPorCriterio: OBJETO com as 11 chaves de "criterios". Cada valor é um ARRAY
   com NO MÁXIMO 3 URLs reais das fontes acima. Use [] se nenhuma fonte menciona.
   Cite as URLs mais relevantes para cada critério, NÃO todas.
   Lembre: se uma resenha descreve o livro, ela serve pra VÁRIOS critérios.

3. criterios: use "nao_identificado" SOMENTE SE (a) você NÃO conhece o livro E
   (b) nenhuma fonte menciona o critério. Se conhece, use "tranquilo" quando não há
   conteúdo explícito sobre o critério.

4. No array "fontes" (final), use APENAS URLs REAIS das fontes acima. NUNCA invente.

CRITÉRIOS (enum: tranquilo|atencao|sensivel|forte|nao_identificado):

⚔️ Violência: brigas, agressões, armas, ferimentos, atos violentos.
   INCLUI: discurso de ódio, racismo, antissemitismo, apologia ao nazismo,
   qualquer forma de discriminação racial ou étnica.

🗣️ Linguagem: palavrões, xingamentos, gírias vulgares, blasfêmias, tom desrespeitoso.

🌈 Identidade de Gênero: se o livro aborda ou promove discussões sobre
   identidade de gênero.

💞 Sexo: romance, paquera, beijos, insinuações ou conteúdo sexual.

😨 Medo/Terror: cenas assustadoras, suspense intenso, pesadelos, ameaças.

☠️ Morte: se a morte aparece, como é tratada, se é central na narrativa.

😔 Bullying: agressão SISTEMÁTICA (perseguição, humilhação repetida,
   intimidação, exclusão). Foco no PADRÃO, não em atitude isolada.

🤝 Respeito: TOM GERAL dos personagens uns com os outros (educação,
   cortesia, sarcasmo, malcriação, tratamento dado a colegas).

📏 Obediência: se a obediência é valorizada e a desobediência é tratada
   como positiva ou engraçada. INCLUI desrespeito a pais, professores,
   adultos, idosos e autoridades. Se personagens desrespeitam professores
   ou autoridades de forma recorrente e positiva (aplaudida pela narrativa),
   marque pelo menos "atencao".

🔮 Ocultismo: magia, bruxaria, rituais, espíritos, práticas esotéricas.

⛪ Oposição ao cristianismo (NEGATIVO): tranquilo = livro não critica a fé;
   forte = livro critica, ridiculariza ou ataca a fé cristã.

VALORES: número 0-5 (0 = nenhum valor, 3 = valores positivos presentes,
5 = valores cristãos explícitos).

NOTA SENSÍVEL: número 0-5 (0 = nada sensível, 5 = muito sensível).

RELIGIÃO: tipo (sem_conteudo|cristao|outra|ocultismo|ambiguo|nao_identificado)
+ descricao + fonte.

ORDEM DAS CHAVES NO JSON (siga EXATAMENTE esta ordem):
1. criterios (objeto com 11 chaves)
2. fontesPorCriterio (objeto com 11 chaves, valores = array de até 3 URLs)
3. religiao (objeto com tipo, descricao, fonte)
4. conclusao (string)
5. fontes (array de {nome, url})
6. vereditoNivel (string)
7. veredito (string)
8. nota (número)
9. valores (número 0-5)
10. notaSensivel (número 0-5)
11. titulo (string)
12. autor (string)
13. editora (string)
14. ano (string)
15. paginas (número)
16. faixaEtaria (string)
17. confiabilidade (string)

Retorne o JSON nesta ordem exata.`;

  const MAX_TENTATIVAS = 3;
  const esperas = [1000, 3000, 6000];
  let fontesAtuais = fontesReduzidas;

  let ultimoErro = null;
  for (let i = 0; i < MAX_TENTATIVAS; i++) {
    const fontesTextoAtual = fontesAtuais.length
      ? fontesAtuais.map((f, idx) => `[${idx + 1}] ${f.titulo}\nURL: ${f.url}\n${f.conteudo}`).join("\n\n")
      : "Nenhuma fonte web.";

    const promptAtual = prompt.replace(
      /FONTES \(\d+\):\n[\s\S]*?\n\nREGRAS CRÍTICAS:/,
      `FONTES (${fontesAtuais.length}):\n${fontesTextoAtual}\n\nREGRAS CRÍTICAS:`
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
          { role: "system", content: "Responda apenas em JSON válido seguindo a ordem de chaves pedida." },
          { role: "user", content: promptAtual }
        ],
        temperature: 0.0,
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
          temperature: 0.0,
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

      if (r.status === 400) {
        const texto = await r.text();
        throw new Error(`${provedor.nome} 400 (JSON inválido): ${texto.slice(0, 200)}`);
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
      if (e.message.includes("400")) throw e;
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
