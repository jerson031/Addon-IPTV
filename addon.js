
const { addonBuilder } = require("stremio-addon-sdk");
const parser = require("iptv-playlist-parser");
const axios = require("axios");
const crypto = require("crypto");

const monitor = require("./monitorIPTV");

// ==========================================
// 1. CONFIGURACIÓN DE LISTAS
// ==========================================

const LISTAS_M3U = [
    {
        id: "chile",
        nombre: "Lista Chile",
        url: "https://m3u.cl/lista/CL.m3u",
        tipo: "auto"
    },
    {
        id: "Animacion",
        nombre: "Series de Animacion",
        url: "https://iptv-org.github.io/iptv/categories/animation.m3u",
        tipo: "auto"
    },
    {
        id: "Documentales",
        nombre: "Documentales",
        url: "https://iptv-org.github.io/iptv/categories/documentary.m3u",
        tipo: "auto"
    }
];

const LIMITE_CATALOGO = 100;

// ==========================================
// 2. ALMACENAMIENTO
// ==========================================

let iptvMovies = [];
let iptvChannels = [];
let inicializacionLista = null;

// ==========================================
// 3. MANIFIESTO
// ==========================================

const manifest = {
    id: "org.miiptvaddon.master",
    version: "2.1.0",
    name: "Mi IPTV Completo",
    description: "Canales, películas y animación de múltiples listas IPTV.",

    resources: [
        "catalog",
        "meta",
        "stream"
    ],

    types: [
        "movie",
        "tv"
    ],

    idPrefixes: [
        "iptv_movie_",
        "iptv_live_"
    ],

    catalogs: [
        {
            type: "movie",
            id: "iptv_movies_catalog",
            name: "🎬 IPTV Películas y Animación",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false }
            ]
        },
        {
            type: "tv",
            id: "iptv_live_catalog",
            name: "📺 IPTV Canales",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false }
            ]
        }
    ]
};

const builder = new addonBuilder(manifest);

// ==========================================
// 4. FUNCIONES GENERALES
// ==========================================

function obtenerTodosLosCanales() {
    return iptvChannels;
}

function normalizarTexto(texto) {
    return String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

// ==========================================
// 5. GENERACIÓN DE IDENTIFICADORES
// ==========================================

function generarId(sourceId, nombre, grupo, url, tipo) {

    const contenido = [
        sourceId,
        tipo,
        normalizarTexto(nombre),
        normalizarTexto(grupo),
        url
    ].join("|");

    const hash = crypto
        .createHash("sha1")
        .update(contenido)
        .digest("hex")
        .substring(0, 20);

    return tipo === "movie"
        ? `iptv_movie_${hash}`
        : `iptv_live_${hash}`;
}

// ==========================================
// 6. BÚSQUEDA DE CONTENIDO
// ==========================================

function buscarContenido(id) {

    return iptvMovies.find(x => x.id === id) ||
        iptvChannels.find(x => x.id === id) ||
        null;
}

// ==========================================
// 7. ESTADO DEL CANAL
// ==========================================

function obtenerTextoEstado(estado) {

    switch (estado?.estado) {

        case "Estable":
            return "🟢 Estable";

        case "Inestable":
            return "🟡 Inestable (posible buffering)";

        case "Caído":
            return "🔴 Caído";

        default:
            return "⚪ Sin evaluar";
    }
}

function generarDescripcionEstado(estado) {

    if (!estado) {
        return "Estado: ⚪ Sin evaluar";
    }

    const lineas = [];

    lineas.push(
        `Estado: ${obtenerTextoEstado(estado)}`
    );

    if (estado.formato && estado.formato !== "Desconocido") {
        lineas.push(`Formato: ${estado.formato}`);
    }

    if (estado.codigoHTTP !== null && estado.codigoHTTP !== undefined) {
        lineas.push(`HTTP: ${estado.codigoHTTP}`);
    }

    if (estado.primerByteMs !== null && estado.primerByteMs !== undefined) {
        lineas.push(`Respuesta inicial: ${estado.primerByteMs} ms`);
    }

    if (estado.tiempoSegmentoMs !== null && estado.tiempoSegmentoMs !== undefined) {
        lineas.push(`Tiempo segmento: ${estado.tiempoSegmentoMs} ms`);
    }

    if (estado.bytesRecibidos > 0) {
        lineas.push(`Datos recibidos: ${estado.bytesRecibidos} bytes`);
    }

    if (estado.error) {
        lineas.push(`Error: ${String(estado.error).slice(0, 120)}`);
    }

    return lineas.join("\n");
}

// ==========================================
// 8. DESCRIPCIÓN DE CONTENIDO
// ==========================================

function generarDescripcion(item) {

    const lineas = [];

    lineas.push(`Proveedor: ${item.proveedor}`);
    lineas.push(`Grupo M3U: ${item.genre}`);

    if (item.type === "tv") {

        const estado = monitor.obtenerEstado(item.id);

        lineas.push(generarDescripcionEstado(estado));
    }

    return lineas.join("\n");
}

// ==========================================
// 9. CATÁLOGO CON BÚSQUEDA Y PAGINACIÓN
// ==========================================

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {

    if (inicializacionLista) {
        await inicializacionLista;
    }

    console.log("\n========== SOLICITUD CATÁLOGO ==========");

    console.log("Tipo:", type);
    console.log("ID:", id);
    console.log("Argumentos:", JSON.stringify(extra));

    let dataset = [];

    if (id === "iptv_movies_catalog") {

        dataset = iptvMovies;

    } else if (id === "iptv_live_catalog") {

        dataset = obtenerTodosLosCanales();

    } else {

        return { metas: [] };
    }

    const totalOriginal = dataset.length;

    // BÚSQUEDA POR NOMBRE, PROVEEDOR Y GRUPO

    const query = normalizarTexto(extra.search);

    if (query) {

        dataset = dataset.filter(item => {

            const textoBusqueda = normalizarTexto([
                item.name,
                item.proveedor,
                item.genre
            ].join(" "));

            return textoBusqueda.includes(query);
        });
    }

    const totalFiltrado = dataset.length;

    // PAGINACIÓN

    const skip = Math.max(
        0,
        parseInt(extra.skip || 0, 10) || 0
    );

    const paginados = dataset.slice(
        skip,
        skip + LIMITE_CATALOGO
    );

    // GENERAR METAS

    const metas = paginados.map(item => ({

        id: item.id,

        type: item.type,

        name: item.name,

        poster: item.logo,

        posterShape: item.type === "tv" ? "square" : "poster",

        description: generarDescripcion(item)
    }));

    console.log("Total original:", totalOriginal);
    console.log("Búsqueda:", query || "Ninguna");
    console.log("Coincidencias:", totalFiltrado);
    console.log("Skip:", skip);
    console.log("Resultados:", metas.length);

    console.log("========================================\n");

    return { metas };
});

// ==========================================
// 10. DETALLES DEL CONTENIDO
// ==========================================

builder.defineMetaHandler(async ({ type, id }) => {

    if (inicializacionLista) {
        await inicializacionLista;
    }

    const item = buscarContenido(id);

    if (!item || item.type !== type) {
        return { meta: null };
    }

    return {

        meta: {

            id: item.id,

            type: item.type,

            name: item.name,

            poster: item.logo,

            background: item.logo,

            description: generarDescripcion(item)
        }
    };
});

// ==========================================
// 11. REPRODUCCIÓN DIRECTA
// ==========================================

builder.defineStreamHandler(async ({ type, id }) => {

    if (inicializacionLista) {
        await inicializacionLista;
    }

    const item = buscarContenido(id);

    if (item && item.type === type && item.streamUrl) {

        return {

            streams: [

                {
                    title: `Reproducción directa | ${item.proveedor}`,

                    url: item.streamUrl
                }
            ]
        };
    }

    return { streams: [] };
});

// ==========================================
// 12. CLASIFICACIÓN DEL CONTENIDO
// ==========================================

function determinarTipo(item, tipoFuente) {

    if (tipoFuente === "movie") {
        return "movie";
    }

    if (tipoFuente === "tv") {
        return "tv";
    }

    const grupo = normalizarTexto(
        typeof item.group === "string"
            ? item.group
            : item.group?.title
    );

    if (/\b(pelicula|peliculas|movie|movies|vod)\b/.test(grupo)) {
        return "movie";
    }

    return "tv";
}

// ==========================================
// 13. DESCARGA DE UNA LISTA M3U
// ==========================================

async function descargarLista(fuente) {

    console.log(`\nDESCARGANDO: ${fuente.nombre}`);

    const respuesta = await axios.get(fuente.url, {

        timeout: 45000,

        responseType: "text",

        maxContentLength: 20 * 1024 * 1024,

        headers: {
            "User-Agent": "Mozilla/5.0 MiIPTVAddon/2.1.0"
        }
    });

    let datosM3U = String(respuesta.data || "")
        .replace(/^\uFEFF/, "");

    const posicion = datosM3U.indexOf("#EXTM3U");

    if (posicion >= 0) {

        datosM3U = datosM3U.substring(posicion);

    } else if (datosM3U.includes("#EXTINF")) {

        datosM3U = "#EXTM3U\n" + datosM3U;

    } else {

        throw new Error("La respuesta no contiene una lista M3U válida");
    }

    const playlist = parser.parse(datosM3U);

    if (!playlist.items || playlist.items.length === 0) {

        throw new Error("La lista no contiene elementos");
    }

    const procesados = [];

    playlist.items.forEach(item => {

        if (!item.url) {
            return;
        }

        const grupoM3U =
            typeof item.group === "string"
                ? item.group.trim()
                : item.group?.title?.trim() || fuente.nombre;

        const nombre = item.name || "Contenido sin nombre";

        const tipo = determinarTipo(item, fuente.tipo);

        const estructurado = {

            id: generarId(
                fuente.id,
                nombre,
                grupoM3U,
                item.url,
                tipo
            ),

            name: nombre,

            logo: item.tvg?.logo || "https://placehold.co/300x450",

            genre: grupoM3U,

            proveedor: fuente.nombre,

            proveedorId: fuente.id,

            streamUrl: item.url,

            type: tipo
        };

        procesados.push(estructurado);
    });

    console.log(`Proveedor: ${fuente.nombre}`);
    console.log(`Elementos descargados: ${playlist.items.length}`);
    console.log(`Elementos procesados: ${procesados.length}`);
    console.log(`Películas: ${procesados.filter(x => x.type === "movie").length}`);
    console.log(`Canales: ${procesados.filter(x => x.type === "tv").length}`);

    return procesados;
}

// ==========================================
// 14. INICIALIZACIÓN DE TODAS LAS LISTAS
// ==========================================

async function inicializarListas() {

    console.log("\n========================================");
    console.log("INICIANDO MI IPTV ADDON 2.1.0");
    console.log("========================================");

    const moviesTmp = [];
    const channelsTmp = [];

    let listasExitosas = 0;

    for (const fuente of LISTAS_M3U) {

        try {

            const elementos = await descargarLista(fuente);

            listasExitosas++;

            elementos.forEach(item => {

                if (item.type === "movie") {

                    moviesTmp.push(item);

                } else {

                    channelsTmp.push(item);
                }
            });

        } catch (error) {

            console.error(
                `ERROR EN LISTA ${fuente.nombre}:`,
                error.message
            );
        }
    }

    if (listasExitosas === 0) {

        throw new Error("No fue posible descargar ninguna lista IPTV");
    }

    // PUBLICAR DATOS

    iptvMovies = moviesTmp;

    iptvChannels = channelsTmp;

    console.log("\n========== SINCRONIZACIÓN COMPLETADA ==========");

    console.log("Listas configuradas:", LISTAS_M3U.length);

    console.log("Listas descargadas:", listasExitosas);

    console.log("Películas:", iptvMovies.length);

    console.log("Canales TV:", iptvChannels.length);

    console.log(
        "Total contenidos:",
        iptvMovies.length + iptvChannels.length
    );

    console.log("================================================\n");

    // INICIAR MONITOR DE CANALES

    if (iptvChannels.length > 0) {

        monitor.iniciar(obtenerTodosLosCanales);
    }
}

// ==========================================
// 15. INICIALIZACIÓN DEL ADDON
// ==========================================

inicializacionLista = inicializarListas();

module.exports = builder.getInterface();
