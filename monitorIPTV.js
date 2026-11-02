const axios = require("axios");

const USER_AGENT = "Mozilla/5.0";
const TIMEOUT_MS = 10000;
const INTERVALO_REVISION = 5 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;
const CONCURRENCIA = 6;

const MAX_BYTES_SEGMENTO = 128 * 1024;
const MAX_BYTES_STREAM = 64 * 1024;

const estados = new Map();

let revisionEnCurso = false;
let temporizador = null;

// ==========================================
// FUNCIONES GENERALES
// ==========================================

function crearResultado(datos = {}) {
    return {
        estado: "Sin evaluar",
        formato: "Desconocido",
        codigoHTTP: null,
        latenciaMs: null,
        primerByteMs: null,
        tiempoSegmentoMs: null,
        bytesRecibidos: 0,
        segmentoDisponible: null,
        error: null,
        detalle: null,
        ultimaRevision: Date.now(),
        ...datos
    };
}

function obtenerEstado(id) {
    return estados.get(id) || crearResultado();
}

// ==========================================
// DESCARGAR PLAYLIST HLS
// ==========================================

async function descargarPlaylist(url) {

    const inicio = Date.now();

    const respuesta = await axios.get(url, {
        timeout: TIMEOUT_MS,
        responseType: "text",
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
        maxRedirects: 5,
        headers: {
            "User-Agent": USER_AGENT
        },
        validateStatus: () => true
    });

    const latencia = Date.now() - inicio;

    if (respuesta.status < 200 || respuesta.status >= 300) {
        const error = new Error(`HTTP ${respuesta.status}`);
        error.codigoHTTP = respuesta.status;
        throw error;
    }

    const contenido = String(respuesta.data || "");

    if (!contenido.includes("#EXTM3U")) {
        throw new Error("La respuesta no contiene una playlist HLS válida");
    }

    return {
        contenido,
        codigoHTTP: respuesta.status,
        latencia
    };
}

// ==========================================
// IDENTIFICAR PLAYLIST MASTER O MEDIA
// ==========================================

function analizarPlaylist(contenido, urlBase) {

    const lineas = contenido
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

    const esMaster = lineas.some(x =>
        x.startsWith("#EXT-X-STREAM-INF")
    );

    // Playlist master: seleccionar una variante.
    if (esMaster) {

        for (let i = 0; i < lineas.length; i++) {

            if (lineas[i].startsWith("#EXT-X-STREAM-INF")) {

                for (let j = i + 1; j < lineas.length; j++) {

                    if (!lineas[j].startsWith("#")) {

                        return {
                            tipo: "master",
                            url: new URL(lineas[j], urlBase).toString()
                        };
                    }
                }
            }
        }

        throw new Error("No se encontró una variante HLS");
    }

    // Playlist de medios: obtener segmentos.
    const segmentos = lineas.filter(x =>
        !x.startsWith("#")
    );

    if (!segmentos.length) {
        throw new Error("La playlist no contiene segmentos");
    }

    return {
        tipo: "media",
        segmentos: segmentos.map(segmento =>
            new URL(segmento, urlBase).toString()
        )
    };
}

// ==========================================
// COMPROBAR SEGMENTO HLS
// ==========================================

async function comprobarSegmento(url) {

    const inicio = Date.now();

    const respuesta = await axios.get(url, {
        timeout: TIMEOUT_MS,
        responseType: "stream",
        maxRedirects: 5,
        headers: {
            "User-Agent": USER_AGENT,
            "Range": `bytes=0-${MAX_BYTES_SEGMENTO - 1}`
        },
        validateStatus: () => true
    });

    if (respuesta.status < 200 || respuesta.status >= 300) {

        if (respuesta.data) {
            respuesta.data.destroy();
        }

        throw new Error(`Error descargando segmento: HTTP ${respuesta.status}`);
    }

    return new Promise((resolve, reject) => {

        let bytes = 0;
        let primerByteMs = null;
        let terminado = false;

        const timeout = setTimeout(() => {
            finalizar(new Error("Tiempo agotado esperando el segmento"));
        }, TIMEOUT_MS);

        function finalizar(error = null) {

            if (terminado) return;

            terminado = true;
            clearTimeout(timeout);

            if (respuesta.data && !respuesta.data.destroyed) {
                respuesta.data.destroy();
            }

            if (error) {
                reject(error);
                return;
            }

            resolve({
                codigoHTTP: respuesta.status,
                primerByteMs,
                tiempoSegmentoMs: Date.now() - inicio,
                bytesRecibidos: bytes
            });
        }

        respuesta.data.on("data", chunk => {

            if (primerByteMs === null) {
                primerByteMs = Date.now() - inicio;
            }

            bytes += chunk.length;

            if (bytes >= MAX_BYTES_SEGMENTO) {
                finalizar();
            }
        });

        respuesta.data.on("end", () => finalizar());

        respuesta.data.on("error", error => {
            finalizar(error);
        });

        respuesta.data.on("aborted", () => {
            finalizar(new Error("Descarga interrumpida"));
        });
    });
}

// ==========================================
// ANALIZAR HLS
// ==========================================

async function analizarHLS(url) {

    const playlistInicial = await descargarPlaylist(url);

    let urlMedia = url;
    let contenidoMedia = playlistInicial.contenido;
    let latenciaTotal = playlistInicial.latencia;

    const resultadoInicial = analizarPlaylist(
        contenidoMedia,
        url
    );

    // Si es una playlist master, descargar una variante.
    if (resultadoInicial.tipo === "master") {

        urlMedia = resultadoInicial.url;

        const playlistMedia = await descargarPlaylist(urlMedia);

        contenidoMedia = playlistMedia.contenido;
        latenciaTotal += playlistMedia.latencia;
    }

    const resultadoMedia = analizarPlaylist(
        contenidoMedia,
        urlMedia
    );

    const segmentos = resultadoMedia.segmentos;

    // Comprobar el último segmento publicado.
    const urlSegmento = segmentos[segmentos.length - 1];

    const segmento = await comprobarSegmento(urlSegmento);

    const lento =
        segmento.primerByteMs > 2500 ||
        segmento.tiempoSegmentoMs > 7000;

    return crearResultado({

        estado: lento ? "Inestable" : "Estable",

        formato: "HLS",

        codigoHTTP: 200,

        latenciaMs: latenciaTotal,

        primerByteMs: segmento.primerByteMs,

        tiempoSegmentoMs: segmento.tiempoSegmentoMs,

        bytesRecibidos: segmento.bytesRecibidos,

        segmentoDisponible: true,

        detalle: lento
            ? "El segmento respondió lentamente"
            : "Playlist y segmento comprobados"
    });
}

// ==========================================
// ANALIZAR STREAM DIRECTO
// ==========================================

async function analizarStreamDirecto(url) {

    const inicio = Date.now();

    const respuesta = await axios.get(url, {

        timeout: TIMEOUT_MS,

        responseType: "stream",

        maxRedirects: 5,

        headers: {
            "User-Agent": USER_AGENT,
            "Range": `bytes=0-${MAX_BYTES_STREAM - 1}`
        },

        validateStatus: () => true
    });

    if (respuesta.status < 200 || respuesta.status >= 300) {

        if (respuesta.data) {
            respuesta.data.destroy();
        }

        throw new Error(`HTTP ${respuesta.status}`);
    }

    return new Promise((resolve, reject) => {

        let bytes = 0;
        let primerByteMs = null;
        let terminado = false;

        const contentType =
            respuesta.headers["content-type"] || "";

        const timeout = setTimeout(() => {
            finalizar(new Error("Tiempo agotado esperando datos"));
        }, TIMEOUT_MS);

        function finalizar(error = null) {

            if (terminado) return;

            terminado = true;
            clearTimeout(timeout);

            if (respuesta.data && !respuesta.data.destroyed) {
                respuesta.data.destroy();
            }

            const tiempoTotal = Date.now() - inicio;

            let formato = "Stream directo";

            if (/mp2t/i.test(contentType)) {
                formato = "MPEG-TS";
            }

            if (/video/i.test(contentType)) {
                formato = "Video";
            }

            if (error || bytes === 0) {

                reject(error || new Error("El servidor no entregó datos"));

                return;
            }

            const lento = primerByteMs > 2500;

            resolve(crearResultado({

                estado: lento ? "Inestable" : "Estable",

                formato,

                codigoHTTP: respuesta.status,

                latenciaMs: tiempoTotal,

                primerByteMs,

                bytesRecibidos: bytes,

                detalle: "Muestra inicial del flujo recibida"
            }));
        }

        respuesta.data.on("data", chunk => {

            if (primerByteMs === null) {
                primerByteMs = Date.now() - inicio;
            }

            bytes += chunk.length;

            if (bytes >= MAX_BYTES_STREAM) {
                finalizar();
            }
        });

        respuesta.data.on("end", () => finalizar());

        respuesta.data.on("error", error => {
            finalizar(error);
        });

        respuesta.data.on("aborted", () => {
            finalizar(new Error("Flujo interrumpido"));
        });
    });
}

// ==========================================
// DIAGNÓSTICO DE UN CANAL
// ==========================================

async function probarCanal(item, forzar = false) {

    if (!item || !item.id || !item.streamUrl) {

        return crearResultado({
            estado: "Caído",
            error: "Canal sin identificador o URL"
        });
    }

    const anterior = estados.get(item.id);

    // Utilizar caché si el diagnóstico sigue vigente.
    if (
        !forzar &&
        anterior &&
        Date.now() - anterior.ultimaRevision < CACHE_MS
    ) {
        return anterior;
    }

    try {

        const url = String(item.streamUrl);

        let resultado;

        if (/\.m3u8(?:$|[?#])/i.test(url)) {

            resultado = await analizarHLS(url);

        } else {

            resultado = await analizarStreamDirecto(url);
        }

        estados.set(item.id, resultado);

        return resultado;

    } catch (error) {

        const resultado = crearResultado({

            estado: "Caído",

            codigoHTTP: error.codigoHTTP || null,

            error: error.code || error.message,

            detalle: "No se pudo comprobar el flujo"
        });

        estados.set(item.id, resultado);

        return resultado;
    }
}

// ==========================================
// REVISIÓN DE TODOS LOS CANALES
// ==========================================

async function revisarCanales(obtenerCanales, forzar = false) {

    if (revisionEnCurso) {
        console.log("[Monitor] Ya existe una revisión en curso.");
        return;
    }

    revisionEnCurso = true;

    try {

        const canales = obtenerCanales();

        let posicion = 0;

        let estables = 0;
        let inestables = 0;
        let caidos = 0;

        async function trabajador() {

            while (posicion < canales.length) {

                const item = canales[posicion++];

                const resultado = await probarCanal(
                    item,
                    forzar
                );

                if (resultado.estado === "Estable") {
                    estables++;
                }

                if (resultado.estado === "Inestable") {
                    inestables++;
                }

                if (resultado.estado === "Caído") {
                    caidos++;
                }

                console.log(
                    `[Monitor] [${resultado.estado}] ${item.name} | ` +
                    `${resultado.formato} | ` +
                    `Primer byte: ${resultado.primerByteMs ?? "N/A"} ms`
                );
            }
        }

        const cantidadTrabajadores = Math.min(
            CONCURRENCIA,
            canales.length
        );

        const trabajadores = Array.from(
            { length: cantidadTrabajadores },
            () => trabajador()
        );

        await Promise.all(trabajadores);

        console.log("\n========== RESUMEN MONITOR IPTV ==========");
        console.log("Total:", canales.length);
        console.log("Estables:", estables);
        console.log("Inestables:", inestables);
        console.log("Caídos:", caidos);
        console.log("==========================================\n");

    } finally {

        revisionEnCurso = false;
    }
}

// ==========================================
// INICIAR MONITOR AUTOMÁTICO
// ==========================================

function iniciar(obtenerCanales) {

    if (temporizador) {
        clearInterval(temporizador);
    }

    revisarCanales(obtenerCanales).catch(error => {
        console.error("[Monitor] Error:", error.message);
    });

    temporizador = setInterval(() => {

        revisarCanales(obtenerCanales).catch(error => {
            console.error("[Monitor] Error:", error.message);
        });

    }, INTERVALO_REVISION);
}

// ==========================================
// EXPORTAR FUNCIONES
// ==========================================

module.exports = {
    iniciar,
    probarCanal,
    revisarCanales,
    obtenerEstado,
    obtenerTodosLosEstados: () => estados
};