const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Configuración de conexión a Azure Postgres
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: 5432,
    ssl: { rejectUnauthorized: false } // Requerido para Azure
});

// --- 1. ESTADO DE LA CORRIDA ---
app.get('/estado-corrida', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, activa FROM corridas ORDER BY id DESC LIMIT 1');
        if (result.rows.length > 0 && result.rows[0].activa) {
            res.json({ activa: true, id_corrida: result.rows[0].id });
        } else {
            res.json({ activa: false });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. INICIAR CORRIDA ---
app.post('/iniciar-corrida', async (req, res) => {
    try {
        await pool.query('UPDATE corridas SET activa = FALSE WHERE activa = TRUE');
        await pool.query('INSERT INTO corridas (activa) VALUES (TRUE)');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. FINALIZAR CORRIDA ---
app.post('/finalizar-corrida', async (req, res) => {
    try {
        await pool.query('UPDATE corridas SET activa = FALSE, fecha_fin = CURRENT_TIMESTAMP WHERE activa = TRUE');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. BUSCAR POR NOMBRE ---
app.get('/buscar-nombre', async (req, res) => {
    const term = req.query.q;
    try {
        const result = await pool.query(
            'SELECT codigo, nombre FROM productos WHERE nombre ILIKE $1 LIMIT 15',
            [`%${term}%`] // ILIKE es para búsqueda que ignora mayúsculas/minúsculas
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. CONSULTAR CÓDIGO / DUPLICADO ---
app.get('/consultar/:codigo/:almacen', async (req, res) => {
    const { codigo, almacen } = req.params;
    try {
        // Buscar en catálogo
        const prod = await pool.query('SELECT nombre FROM productos WHERE codigo = $1', [codigo]);
        if (prod.rows.length === 0) return res.json({ existe: false });

        // Buscar duplicado en la corrida actual
        const dup = await pool.query(`
            SELECT usuario FROM inventario 
            WHERE codigo = $1 AND almacen = $2 
            AND id_corrida = (SELECT id FROM corridas WHERE activa = TRUE ORDER BY id DESC LIMIT 1)
        `, [codigo, almacen]);

        res.json({ 
            existe: true, 
            nombre: prod.rows[0].nombre, 
            repetido: dup.rows.length > 0,
            mensajeRepetido: dup.rows.length > 0 ? `Ya registrado por ${dup.rows[0].usuario}` : ""
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. GUARDAR CAPTURA ---
app.post('/guardar', async (req, res) => {
    const { codigo, nombre, cantidad, almacen, usuario } = req.body;
    try {
        await pool.query(`
            INSERT INTO inventario (codigo, nombre, cantidad, almacen, usuario, id_corrida)
            VALUES ($1, $2, $3, $4, $5, (SELECT id FROM corridas WHERE activa = TRUE ORDER BY id DESC LIMIT 1))
        `, [codigo, nombre, cantidad, almacen, usuario]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 7. BORRAR / RESETEAR ---
app.post('/borrar-captura', async (req, res) => {
    const { codigo, almacen } = req.body;
    try {
        await pool.query(`
            DELETE FROM inventario 
            WHERE codigo = $1 AND almacen = $2 
            AND id_corrida = (SELECT id FROM corridas WHERE activa = TRUE ORDER BY id DESC LIMIT 1)
        `, [codigo, almacen]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// --- ENDPOINT DE EXPORTACIÓN CORREGIDO Y COMPLETO ---
// --- ENDPOINT DE EXPORTACIÓN CORREGIDO (AGRUPADO POR ALMACÉN Y SUMA USUARIOS) ---
app.get('/exportar-csv/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                i.almacen, 
                i.codigo, 
                i.nombre, 
                SUM(i.cantidad) as cantidad_total, 
                STRING_AGG(DISTINCT i.usuario, ', ') as usuarios_lista, 
                MAX(i.fecha) as fecha_final,
                -- Si no existe en la tabla productos, es un NUEVO
                CASE WHEN p.codigo IS NULL THEN 'SÍ' ELSE 'NO' END as es_nuevo
            FROM inventario i
            LEFT JOIN productos p ON i.codigo = p.codigo
            WHERE i.id_corrida = $1
            GROUP BY i.almacen, i.codigo, i.nombre, p.codigo
            ORDER BY es_nuevo ASC, i.almacen ASC, i.nombre ASC
        `, [id]);
        
        const header = "Almacen,Codigo,Nombre,Cantidad Total,Usuarios,Ultimo Registro,Nuevo en Sistema\n";
        
        const rows = result.rows.map(r => {
            const fechaFormateada = r.fecha_final ? new Date(r.fecha_final).toISOString().replace(/T/, ' ').replace(/\..+/, '') : '---';
            const codigoExcel = `="${r.codigo}"`; // Evita el +E12
            const nombreFinal = r.es_nuevo === 'SÍ' ? `[ALTA POS] ${r.nombre}` : r.nombre;

            return `${r.almacen},${codigoExcel},"${nombreFinal.replace(/"/g, '""')}",${r.cantidad_total},"${r.usuarios_lista}",${fechaFormateada},${r.es_nuevo}`;
        }).join("\n");

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=inventario_gdl_${id}.csv`);
        res.status(200).send('\uFEFF' + header + rows);
    } catch (err) { res.status(500).send("Error al generar reporte"); }
});


// --- CRUD USUARIOS ---
app.get('/usuarios-list', async (req, res) => {
    const result = await pool.query('SELECT * FROM usuarios_app ORDER BY nombre ASC');
    res.json(result.rows);
});

app.post('/usuarios-add', async (req, res) => {
    const { nombre } = req.body;
    await pool.query('INSERT INTO usuarios_app (nombre) VALUES ($1)', [nombre]);
    res.json({ success: true });
});

app.post('/usuarios-delete', async (req, res) => {
    const { id } = req.body;
    await pool.query('DELETE FROM usuarios_app WHERE id = $1', [id]);
    res.json({ success: true });
});

// --- CRUD ALMACENES ---
app.get('/almacenes-list', async (req, res) => {
    const result = await pool.query('SELECT * FROM almacenes_app ORDER BY nombre ASC');
    res.json(result.rows);
});

app.post('/almacenes-add', async (req, res) => {
    const { nombre } = req.body;
    await pool.query('INSERT INTO almacenes_app (nombre) VALUES ($1)', [nombre]);
    res.json({ success: true });
});

app.post('/almacenes-delete', async (req, res) => {
    const { id } = req.body;
    await pool.query('DELETE FROM almacenes_app WHERE id = $1', [id]);
    res.json({ success: true });
});


// --- 8. EXPORTAR DATOS ---
app.get('/exportar-final', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.*, c.fecha_inicio as inicio_inventario 
            FROM inventario i 
            JOIN corridas c ON i.id_corrida = c.id 
            WHERE i.id_corrida = (SELECT id FROM corridas ORDER BY id DESC LIMIT 1)
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});



app.get('/corridas', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, fecha_inicio, activa FROM corridas ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MODIFICADO: CONSULTAR TODO DE UNA CORRIDA ESPECÍFICA ---
app.get('/consultar-todo/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                usuario, 
                almacen, 
                codigo, 
                nombre, 
                SUM(cantidad) as cantidad, 
                MAX(fecha) as fecha 
            FROM inventario 
            WHERE id_corrida = $1
            GROUP BY usuario, almacen, codigo, nombre
            ORDER BY fecha DESC
        `, [id]);
        res.json(result.rows);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Postgres API lista en puerto ${PORT}`));