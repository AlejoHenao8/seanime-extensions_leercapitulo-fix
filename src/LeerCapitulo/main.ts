/// <reference path="../manga-provider.d.ts" />

class Provider {
  private baseUrl = "https://www.leercapitulo.co";

  // ---------------------------------------------------------------------
  // BÚSQUEDA
  // El HTML del sitio no muestra a qué URL llama el buscador en vivo
  // (lo hace con JavaScript). Estas son plantillas candidatas; la primera
  // que responda con resultados se usa. Si conoces la URL real, ponla
  // PRIMERA en la lista ({q} = texto buscado).
  // ---------------------------------------------------------------------
  private searchTemplates = [
    "/manga/?q={q}",
    "/manga/?search={q}",
    "/search?q={q}",
    "/api/search?q={q}",
    "/buscar?q={q}",
    "/search-autocomplete?q={q}",
  ];
  private workingSearch: string | null = null;

  getSettings(): Settings {
    return {
      supportsMultiLanguage: false,
      supportsMultiScanlator: false,
    };
  }

  // ------------------------------ utilidades ---------------------------

  private headers() {
    return {
      Referer: `${this.baseUrl}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    };
  }

  private abs(u: string): string {
    if (!u) return "";
    if (u.startsWith("//")) return "https:" + u;
    if (u.startsWith("http")) return u;
    return this.baseUrl + (u.startsWith("/") ? u : "/" + u);
  }

  private decode(s: string): string {
    return s
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ");
  }

  private stripTags(s: string): string {
    return this.decode(s.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  private attr(tag: string, name: string): string {
    const m = tag.match(new RegExp("\\s" + name + '="([^"]*)"', "i"));
    return m ? this.decode(m[1]) : "";
  }

  private slugToTitle(slug: string): string {
    return slug.replace(/-/g, " ").trim();
  }

  // ------------------------- parseo de resultados ----------------------

  private parseSearchHtml(html: string): SearchResult[] {
    const out: SearchResult[] = [];
    const indexById: { [id: string]: number } = {};
    const re =
      /<a\b[^>]*href="(?:https?:\/\/www\.leercapitulo\.co)?\/manga\/([a-z0-9]+)\/([^"\/?#]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;

    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      const slug = m[2];
      const inner = m[3];
      const path = `/manga/${id}/${slug}/`;

      let title = this.stripTags(inner);
      const imgTag = inner.match(/<img\b[^>]*>/i);
      let image = "";
      if (imgTag) {
        image = this.attr(imgTag[0], "src") || this.attr(imgTag[0], "data-src");
        if (!title) {
          title = this.attr(imgTag[0], "alt").replace(/^Portada de\s*/i, "");
        }
      }

      if (indexById[id] === undefined) {
        indexById[id] = out.length;
        out.push({
          id: path,
          title: title || this.slugToTitle(slug),
          image: image ? this.abs(image) : "",
        });
      } else {
        const item = out[indexById[id]];
        if (title && (item.title === this.slugToTitle(slug) || !item.title)) {
          item.title = title;
        }
        if (image && !item.image) item.image = this.abs(image);
      }
    }
    return out;
  }

  private parseSearchJson(data: any): SearchResult[] {
    const arr: any[] = Array.isArray(data)
      ? data
      : (data && (data.results || data.data || data.items || data.mangas)) ||
        [];
    const out: SearchResult[] = [];
    if (!Array.isArray(arr)) return out;

    for (const item of arr) {
      if (!item) continue;
      const link = String(item.link || item.url || item.href || item.path || "");
      const m = link.match(/\/manga\/([a-z0-9]+)\/([^\/?#]+)/);
      if (!m) continue;
      out.push({
        id: `/manga/${m[1]}/${m[2]}/`,
        title: String(
          item.label || item.title || item.name || this.slugToTitle(m[2]),
        ),
        image: this.abs(
          String(item.thumbnail || item.image || item.cover || item.img || ""),
        ),
      });
    }
    return out;
  }

  // ------------------------------- search ------------------------------

  async search(opts: QueryOptions): Promise<SearchResult[]> {
    const q = encodeURIComponent(opts.query);
    const templates = this.workingSearch
      ? [this.workingSearch]
      : this.searchTemplates;

    const tokens = opts.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3);

    let results: SearchResult[] = [];

    for (const t of templates) {
      const url = this.baseUrl + t.replace("{q}", q);
      try {
        const res = await fetch(url, { headers: this.headers() });
        console.log("LeerCapitulo search", url, "->", res.status);
        if (!res.ok) continue;

        const text = await res.text();
        const trimmed = text.trim();

        let parsed: SearchResult[] = [];
        if (trimmed[0] === "[" || trimmed[0] === "{") {
          try {
            parsed = this.parseSearchJson(JSON.parse(trimmed));
          } catch (e) {}
        }
        if (!parsed.length) parsed = this.parseSearchHtml(text);
        if (!parsed.length) continue;

        // Si devuelve muchísimos resultados y ninguno se parece a la
        // búsqueda, la URL probablemente ignora el parámetro (catálogo
        // completo): se descarta esa plantilla.
        if (parsed.length >= 10 && tokens.length) {
          const related = parsed.some((r) => {
            const hay = (r.title + " " + r.id).toLowerCase();
            return tokens.some((tok) => hay.indexOf(tok) !== -1);
          });
          if (!related) {
            console.log("LeerCapitulo: la plantilla ignora el texto:", t);
            continue;
          }
        }

        this.workingSearch = t;
        results = parsed;
        break;
      } catch (e) {
        console.log("LeerCapitulo search error", url, String(e));
      }
    }

    // Pocos resultados: se piden los títulos alternativos de cada serie
    // (la página los muestra separados por " · ") para que Seanime pueda
    // emparejar por nombre en japonés/inglés.
    if (results.length > 0 && results.length <= 6) {
      for (const item of results) {
        try {
          const r = await fetch(this.abs(item.id), { headers: this.headers() });
          if (!r.ok) continue;
          const html = await r.text();
          const p = html.match(
            /<p[^>]*class="[^"]*lc-muted[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
          );
          if (p) {
            const syn = this.stripTags(p[1])
              .split("·")
              .map((s) => s.trim())
              .filter(Boolean);
            if (syn.length) item.synonyms = syn;
          }
        } catch (e) {}
      }
    }

    return results;
  }

  // ----------------------------- capítulos -----------------------------

  async findChapters(mangaId: string): Promise<ChapterDetails[]> {
    let res: Response;
    try {
      res = await fetch(this.abs(mangaId), { headers: this.headers() });
    } catch (e) {
      console.log("LeerCapitulo findChapters error", String(e));
      return [];
    }
    if (!res.ok) {
      console.log("LeerCapitulo findChapters status", res.status);
      return [];
    }

    const html = await res.text();

    // <a class="lc-chapter-row" href="/leer/ID/slug/181/">
    //    <span class="n">Capitulo 181</span> ...
    const re = /<a\b[^>]*class="[^"]*lc-chapter-row[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
    const rows = html.match(re) || [];

    const found: { url: string; title: string; num: number; raw: string }[] =
      [];
    const seen: { [u: string]: boolean } = {};

    for (const row of rows) {
      const href = this.attr(row, "href");
      if (!href || seen[href]) continue;
      seen[href] = true;

      const parts = href.split("/").filter(Boolean);
      const raw = parts[parts.length - 1];
      const num = parseFloat(raw);

      const nSpan = row.match(/<span[^>]*class="n"[^>]*>([\s\S]*?)<\/span>/i);
      const title = nSpan ? this.stripTags(nSpan[1]) : `Capitulo ${raw}`;

      found.push({ url: href, title, num, raw });
    }

    if (!found.length) {
      console.log("LeerCapitulo: no se encontraron filas lc-chapter-row");
      return [];
    }

    // Orden ascendente por número de capítulo
    found.sort((a, b) => {
      const an = isNaN(a.num) ? 0 : a.num;
      const bn = isNaN(b.num) ? 0 : b.num;
      return an - bn;
    });

    return found.map((c, i) => ({
      id: c.url,
      url: this.abs(c.url),
      title: c.title,
      chapter: String(c.raw),
      index: i,
    }));
  }

  // ------------------------------ páginas ------------------------------

  // Base64 propio (Seanime/goja puede no tener Buffer ni atob)
  private b64decode(input: string): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const str = input.replace(/=+$/, "");
    let out = "";
    let bits = 0;
    let acc = 0;
    for (const c of str) {
      const v = chars.indexOf(c);
      if (v < 0) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 0xff);
        acc &= (1 << bits) - 1;
      }
    }
    return out;
  }

  // Método antiguo del sitio (id="array_data"), por si todavía existe
  private decodeArrayData(arrayData: string): string[] {
    const pairs: string[][] = [
      ["0","w"],["1","j"],["2","H"],["3","A"],["4","V"],["5","Q"],["6","P"],["7","3"],["8","L"],["9","Y"],
      ["A","m"],["B","t"],["C","R"],["D","o"],["E","B"],["F","x"],["G","T"],["H","C"],["I","N"],["J","0"],
      ["K","S"],["L","D"],["M","f"],["N","F"],["O","y"],["P","h"],["Q","7"],["R","c"],["S","s"],["T","d"],
      ["U","9"],["V","e"],["W","J"],["X","z"],["Y","X"],["Z","b"],
      ["a","a"],["b","I"],["c","q"],["d","G"],["e","n"],["f","2"],["g","Z"],["h","M"],["i","5"],["j","6"],
      ["k","u"],["l","O"],["m","i"],["n","l"],["o","g"],["p","r"],["q","K"],["r","v"],["s","p"],["t","8"],
      ["u","4"],["v","U"],["w","W"],["x","E"],["y","1"],["z","k"],
    ];
    const map: { [k: string]: string } = {};
    for (const [a, b] of pairs) map[a] = b;
    const replaced = arrayData.replace(/[A-Za-z0-9]/g, (ch) => map[ch] || ch);
    let decoded = "";
    try {
      decoded = this.b64decode(replaced);
    } catch (e) {
      return [];
    }
    return decoded
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.indexOf("http") === 0);
  }

  private isPageImage(u: string): boolean {
    const low = u.toLowerCase();
    if (low.indexOf("data:") === 0) return false;
    if (low.indexOf("/covers/") !== -1) return false;
    if (low.indexOf("/assets/") !== -1) return false;
    if (low.indexOf("logo") !== -1 || low.indexOf("favicon") !== -1) return false;
    return true;
  }

  // Atributo sin regex (más seguro en el motor de Seanime)
  private attrPlain(tag: string, name: string): string {
    const flat = tag.split("\r").join(" ").split("\n").join(" ").split("\t").join(" ");
    const needle = " " + name + '="';
    const start = flat.indexOf(needle);
    if (start === -1) return "";
    const from = start + needle.length;
    const end = flat.indexOf('"', from);
    if (end === -1) return "";
    return this.decode(flat.substring(from, end));
  }

  async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
    console.log("LeerCapitulo findChapterPages v2026-10-19b inicio:", chapterId);
    try {
      const res = await fetch(this.abs(chapterId), { headers: this.headers() });
      if (!res.ok) {
        console.log("LeerCapitulo findChapterPages status", res.status);
        return [];
      }

      const html: string = await res.text();
      console.log("LeerCapitulo capítulo descargado, bytes:", html.length);

      let urls: string[] = [];
      let method = "";

      // Método A (sin regex): <img data-src="..."> dentro de id="lcPages"
      const mStart = html.indexOf('id="lcPages"');
      let block = "";
      if (mStart !== -1) {
        const gt = html.indexOf(">", mStart);
        const mEnd = html.indexOf("</main>", gt);
        block = html.substring(gt + 1, mEnd === -1 ? html.length : mEnd);
      }

      if (block) {
        const Etiquetas: string[] = [];
        let pos = 0;
        while (true) {
          const a = block.indexOf("<img", pos);
          if (a === -1) break;
          const b = block.indexOf(">", a);
          if (b === -1) break;
          Etiquetas.push(block.substring(a, b + 1));
          pos = b + 1;
        }

        const tmp: { url: string; index: number }[] = [];
        let seq = 0;
        for (const tag of Etiquetas) {
          const src =
            this.attrPlain(tag, "data-src") ||
            this.attrPlain(tag, "data-original") ||
            this.attrPlain(tag, "data-lazy-src") ||
            this.attrPlain(tag, "data-url") ||
            this.attrPlain(tag, "src");
          if (!src || !this.isPageImage(src)) continue;
          const idxStr = this.attrPlain(tag, "data-index");
          const parsed = parseInt(idxStr, 10);
          const idx = isNaN(parsed) ? seq : parsed;
          seq++;
          tmp.push({ url: this.abs(src), index: idx });
        }
        tmp.sort((x, y) => x.index - y.index);
        urls = tmp.map((t) => t.url);
        if (urls.length) method = "A";
      }

      // Método B: URLs de imagen sueltas en el HTML
      if (!urls.length) {
        try {
          const flat = html.split("\\/").join("/");
          const re = /https?:\/\/[^"'\s<>\\)]+?\.(?:webp|jpe?g|png|avif)(?:\?[^"'\s<>\\)]*)?/gi;
          const found = flat.match(re) || [];
          const seen: { [u: string]: boolean } = {};
          for (const u of found) {
            if (seen[u] || !this.isPageImage(u)) continue;
            seen[u] = true;
            urls.push(u);
          }
          if (urls.length) method = "B";
        } catch (e) {
          console.log("LeerCapitulo método B falló:", String(e));
        }
      }

      // Método C: array_data cifrado (sitio antiguo)
      if (!urls.length) {
        try {
          const k = html.indexOf('id="array_data"');
          if (k !== -1) {
            const gt = html.indexOf(">", k);
            const lt = html.indexOf("<", gt + 1);
            urls = this.decodeArrayData(html.substring(gt + 1, lt).trim());
            if (urls.length) method = "C";
          }
        } catch (e) {
          console.log("LeerCapitulo método C falló:", String(e));
        }
      }

      console.log(
        "LeerCapitulo páginas:",
        chapterId,
        "método:",
        method || "NINGUNO",
        "total:",
        urls.length,
      );

      if (!urls.length) {
        console.log("LeerCapitulo DEBUG bloque lcPages:", block ? block.slice(0, 600) : "(no existe lcPages)");
        return [];
      }

      return urls.map((u, i) => ({
        url: u,
        index: i,
        headers: { Referer: `${this.baseUrl}/` },
      }));
    } catch (e) {
      const err: any = e;
      console.log(
        "LeerCapitulo findChapterPages EXCEPCIÓN:",
        String(err),
        err && err.stack ? err.stack : "",
      );
      return [];
    }
  }
}

