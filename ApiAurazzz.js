const express = require('express');
const PORT = process.env.PORT || 5000;
var app = express();
var fire = require('./fire');
var admin = require('firebase-admin'); 
var cors = require('cors');
var bodyParser = require('body-parser');

// --- LIBRERÍAS PARA EL AUDIO E IA ---
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// Configuración de multer: guardará los audios del ESP32 temporalmente aquí
const upload = multer({ dest: 'uploads/' });
// --------------------------------------

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const db = fire.firestore();

// PÁGINA DE INICIO 
app.get('/', (req, res) => {
  res.send(`
    <h1>API AuraZzz - Sistema de Detección de Ronquidos</h1>
    <p>Estado: 🟢 Operacional</p>
    <h2>Endpoints Principales</h2>
    <ul>
      <li><b>POST /procesar-audio</b> - Recibe audio del ESP32 y lo envía a IA</li>
      <li><b>POST /ronquidos</b> - Para pruebas manuales de texto</li>
      <li><b>POST /sesiones</b> - Crear resumen de noche</li>
      <li><b>GET /dispositivo/:id/config</b> - Configuración para el ESP32</li>
    </ul>
  `);
});

// DISPOSITIVOS (Configuración y Estado)
app.get('/dispositivo/:id/config', (req, res) => {
  db.collection('dispositivos').doc(req.params.id).get()
    .then(doc => {
      if (!doc.exists) return res.status(404).send({ error: 'No encontrado' });
      const d = doc.data();
      res.send({
        alarma_activa: d.alarma_activa,
        alarma_hora: d.alarma_hora,
        umbral: d.umbral,
        sesion_sueño_id: d.sesion_sueño_id 
      });
    })
    .catch(err => res.status(500).send({ error: err.message }));
});

// Registrar última conexión del ESP32
app.patch('/dispositivo/:id/ping', (req, res) => {
  db.collection('dispositivos').doc(req.params.id).update({
    ultima_conexion: admin.firestore.FieldValue.serverTimestamp()
  })
  .then(() => res.send({ status: 'Online' }))
  .catch(err => res.status(500).send({ error: err.message }));
});

// REGISTRO MANUAL DE RONQUIDOS
app.post('/ronquidos', (req, res) => {
  const ronquido = {
    id_dispositivo: req.body.id_dispositivo,
    duracion: parseFloat(req.body.duracion) || 0, 
    intensidad_db: parseFloat(req.body.intensidad_db) || 0,
    sesion_id: req.body.sesion_id || "",
    fecha_hora: admin.firestore.FieldValue.serverTimestamp() 
  };
  
  db.collection('registro_ronquidos').add(ronquido)
    .then(docRef => res.send({ id: docRef.id, status: 'Evento registrado manualmente' }))
    .catch(err => res.status(500).send({ error: err.message }));
});

// --- ENDPOINT PRINCIPAL: PUENTE IA (NODE -> PYTHON) ---
app.post('/procesar-audio', upload.single('audio_file'), async (req, res) => {
  try {
    console.log('\n==================================================');
    console.log('📥 ¡IMPACTO DESDE EL ESP32 RECIBIDO!');
    console.log('==================================================');
    
    // 1. Verificamos que llegó el archivo
    if (!req.file) {
      console.log('❌ Error: El ESP32 no mandó ningún archivo binario.');
      return res.status(400).send({ error: 'Falta el archivo de audio (key: audio_file)' });
    }

    console.log(`📂 Archivo cargado en caché: ${req.file.path}`);
    console.log(`📏 Tamaño recibido: ${req.file.size} bytes`);
    console.log(`📡 ID del Dispositivo: ${req.body.id_dispositivo || 'No provisto'}`);
    console.log(`🔊 Intensidad medida por hardware: ${req.body.intensidad_db || '0'}`);

    // 2. Empaquetamos todo para enviarlo a FastAPI
    console.log('🚀 Empaquetando stream binario y enviando a FastAPI (Python)...');
    const form = new FormData();
    form.append('id_dispositivo', req.body.id_dispositivo || 'AURAZZZ_01');
    form.append('intensidad', req.body.intensidad_db || 0);
    form.append('file', fs.createReadStream(req.file.path), req.file.originalname);

    // 3. Petición a Python (Asegúrate de que uvicorn esté corriendo en el puerto 8000)
    const urlPython = 'http://127.0.0.1:8000/analizar-evento';
    const respuestaPython = await axios.post(urlPython, form, {
      headers: { ...form.getHeaders() }
    });

    // 4. Borramos el archivo de Node para ahorrar espacio
    fs.unlinkSync(req.file.path);
    console.log('🗑️  Memoria caché de Node limpia (archivo temporal eliminado).');
    
    const analisis = respuestaPython.data;
    console.log('🧠 Respuesta del servidor de IA (Python):');
    console.log(JSON.stringify(analisis, null, 2));

    // 5. Guardamos en Firebase SI es ronquido o si detectó apnea
    if (analisis.es_ronquido_real || (analisis.analisis_apnea && analisis.analisis_apnea.apnea_detectada)) {
      console.log('💾 [ALERTA] Evento crítico detectado. Escribiendo en Firestore...');
      
      const eventoFinal = {
        id_dispositivo: analisis.id_dispositivo || req.body.id_dispositivo,
        es_ronquido_real: analisis.es_ronquido_real,
        intensidad_db: parseInt(analisis.intensidad_medida || req.body.intensidad_db),
        apnea_detectada: analisis.analisis_apnea ? analisis.analisis_apnea.apnea_detectada : false,
        detalle_apnea: analisis.analisis_apnea ? analisis.analisis_apnea.detalle : "N/A",
        fecha_hora: admin.firestore.FieldValue.serverTimestamp()
      };
      
      const docRef = await db.collection('registro_ronquidos').add(eventoFinal);
      console.log(`✅ Guardado con éxito en Firestore. ID: ${docRef.id}`);
    } else {
      console.log('💤 Ruido irrelevante según Python. Ignorando guardado en Base de Datos.');
    }

    console.log('==================================================\n');
    res.send({ status: 'Analizado por IA', resultados: analisis });

  } catch (err) {
    console.error("\n💥 [ERROR] Falló el puente en Node.js:");
    console.error("Detalle:", err.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
      console.log('🗑️  Archivo temporal limpiado tras error.');
    }
    console.log('==================================================\n');
    res.status(500).send({ error: 'Error interno procesando el audio con IA' });
  }
});

// SESIÓN DE SUEÑO (Resumen Médico)
app.post('/sesiones', (req, res) => {
  const sesion = {
    usuario_id: req.body.usuario_id || "",
    id_dispositivo: req.body.id_dispositivo || "", 
    fecha: admin.firestore.FieldValue.serverTimestamp(),
    total_ronquidos: parseInt(req.body.total_ronquidos) || 0,
    promedio_db: parseFloat(req.body.promedio_db) || 0,
    pico_max_db: parseFloat(req.body.pico_max_db) || 0,
    puntuacion_sueño: parseInt(req.body.puntuacion_sueño) || 0,
    indice_apnea: parseInt(req.body.indice_apnea) || 0,
    ronquido_severo: parseInt(req.body.ronquido_severo) || 0,
    ritmo_respiratorio: req.body.ritmo_respiratorio || "regular",
    alerta_medica: req.body.alerta_medica || false,
    recomendacion_ia: req.body.recomendacion_ia || ""
  };

  db.collection('sesion_sueño').add(sesion)
    .then(docRef => res.send({ id: docRef.id, status: 'Sesión guardada' }))
    .catch(err => res.status(500).send({ error: err.message }));
});

// USUARIOS
app.post('/usuarios', (req, res) => {
  const nuevoUsuario = {
    correo: req.body.correo,
    nombre: req.body.nombre,
    id_dispositivo: req.body.id_dispositivo,
    meta_sueño: parseInt(req.body.meta_sueño) || 8
  };
  db.collection('usuarios').add(nuevoUsuario)
    .then(docRef => res.send({ id: docRef.id, status: 'Usuario creado' }))
    .catch(err => res.status(500).send({ error: err.message }));
});

// ESCUCHANDO EN LA RED LOCAL
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API AuraZzz actualizada y corriendo en puerto ${PORT}`);
});

