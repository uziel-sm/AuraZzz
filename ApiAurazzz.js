const express = require('express');
const PORT = process.env.PORT || 5000;
var app = express();
var fire = require('./fire');
var admin = require('firebase-admin'); 
var cors = require('cors');
var bodyParser = require('body-parser');

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const db = fire.firestore();

// ============================================================
// PÁGINA DE INICIO - Documentación de la API
// ============================================================
app.get('/', (req, res) => {
  res.send(`
    <h1>API AuraZzz - Sistema de Detección de Ronquidos</h1>
    <p>Estado: 🟢 Operacional</p>
    <h2>Endpoints Principales</h2>
    <ul>
      <li><b>POST /ronquidos</b> - Para el ESP32</li>
      <li><b>POST /sesiones</b> - Crear resumen de noche</li>
      <li><b>GET /dispositivo/:id/config</b> - Configuración para el ESP32</li>
    </ul>
  `);
});

// ============================================================
// DISPOSITIVOS (Configuración y Estado)
// ============================================================
app.get('/dispositivo/:id/config', (req, res) => {
  db.collection('dispositivos').doc(req.params.id).get()
    .then(doc => {
      if (!doc.exists) return res.status(404).send({ error: 'No encontrado' });
      const d = doc.data();
      res.send({
        alarma_activa: d.alarma_activa,
        alarma_hora: d.alarma_hora,
        umbral: d.umbral,
        sesion_sueño_id: d.sesion_sueño_id // Para que el ESP32 sepa a qué sesión asociar
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

// ============================================================
// REGISTRO DE RONQUIDOS (Basado en tu captura)
// ============================================================
app.post('/ronquidos', (req, res) => {
  const ronquido = {
    id_dispositivo: req.body.id_dispositivo,
    duracion: parseFloat(req.body.duracion) || 0,
    intensidad_db: parseFloat(req.body.intensidad_db) || 0,
    sesion_id: req.body.sesion_id || "", // Vinculación con la sesión actual
    fecha_hora: admin.firestore.FieldValue.serverTimestamp() // Nombre corregido según captura
  };
  
  db.collection('registro_ronquidos').add(ronquido)
    .then(docRef => res.send({ id: docRef.id, status: 'Evento registrado' }))
    .catch(err => res.status(500).send({ error: err.message }));
});

// ============================================================
// SESIÓN DE SUEÑO (Resumen Médico - Basado en tu captura)
// ============================================================
app.post('/sesiones', (req, res) => {
  const sesion = {
    usuario_id: req.body.usuario_id || "",
    id_dispositivo: req.body.id_dispositivo || "", // Añadido según tu captura
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

// ============================================================
// USUARIOS
// ============================================================
app.post('/usuarios', (req, res) => {
  const nuevoUsuario = {
    correo: req.body.correo,
    nombre: req.body.nombre,
    id_dispositivo: req.body.id_dispositivo, // "AURAZZZ_01" según tu captura
    meta_sueño: parseInt(req.body.meta_sueño) || 8
  };
  db.collection('usuarios').add(nuevoUsuario)
    .then(docRef => res.send({ id: docRef.id, status: 'Usuario creado' }))
    .catch(err => res.status(500).send({ error: err.message }));
});

app.listen(PORT, () => {
  console.log(`API AuraZzz actualizada y corriendo en puerto ${PORT}`);
});