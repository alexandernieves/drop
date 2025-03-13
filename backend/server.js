const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// NUEVAS IMPORTACIONES para User-Agent (ya no usaremos IP)
const useragent = require('useragent');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar Express para confiar en el proxy (si se usa)
app.set('trust proxy', true);

// Middlewares
app.use(cors());
app.use(express.json());

// Configuración de Multer para manejo de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Carpeta donde se guardarán los archivos
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Conexión a la base de datos
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT || 3306,
});

db.connect((err) => {
  if (err) {
    console.error('Error de conexión a la base de datos:', err);
    return;
  }
  console.log('Conexión exitosa a la base de datos');
});

// =====================================================
// ===============     ENDPOINTS      ==================
// =====================================================

// [1] Endpoint de registro
app.post('/api/register', async (req, res) => {
  try {
    const { firstName, lastName, phone, countryCode, email, password, role } = req.body;
    const roleQuery = 'SELECT id FROM roles WHERE name = ? LIMIT 1';
    db.query(roleQuery, [role], async (err, roleResults) => {
      if (err) {
        console.error('Error obteniendo el rol:', err);
        return res.status(500).json({ error: 'Error al obtener el rol' });
      }
      if (roleResults.length === 0) {
        return res.status(400).json({ error: 'Rol inválido' });
      }
      const roleId = roleResults[0].id;
      const hashedPassword = await bcrypt.hash(password, 10);
      const userUuid = uuidv4();
      const insertUserQuery = `
        INSERT INTO users (
          uuid, first_name, last_name, country_code, phone, email, password, role_id,
          created_at, updated_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'OFF')
      `;
      db.query(
        insertUserQuery,
        [userUuid, firstName, lastName, countryCode, phone, email, hashedPassword, roleId],
        (err, result) => {
          if (err) {
            console.error('Error en el registro:', err);
            return res.status(500).json({ error: 'Error al registrar usuario' });
          }
          const updateStatusQuery = `UPDATE users SET status = 'ON' WHERE id = ?`;
          db.query(updateStatusQuery, [result.insertId], (err) => {
            if (err) {
              console.error('Error actualizando el status a ON:', err);
              return res.status(500).json({ error: 'Error al actualizar el estado del usuario' });
            }
          });
          return res.status(201).json({
            message: 'Usuario registrado exitosamente',
            userId: result.insertId,
            uuid: userUuid,
            roleId: roleId,
          });
        }
      );
    });
  } catch (error) {
    console.error('Error al registrar usuario:', error);
    return res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// [2] Endpoint de login (sin columnas ip, city, country)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  const selectQuery = `
    SELECT users.*, roles.name AS role_name 
    FROM users 
    INNER JOIN roles ON users.role_id = roles.id
    WHERE users.email = ? 
    LIMIT 1
  `;

  db.query(selectQuery, [email], async (err, results) => {
    if (err) {
      console.error('Error en la consulta de login:', err);
      return res.status(500).json({ error: 'Error en el servidor' });
    }
    if (results.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
    }

    const user = results[0];
    try {
      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
      }
    } catch (compareError) {
      console.error('Error comparando contraseñas:', compareError);
      return res.status(500).json({ error: 'Error en la comparación de contraseñas' });
    }

    // Actualizar last_login y status
    const updateLastLoginQuery = `UPDATE users SET last_login = NOW() WHERE id = ?`;
    db.query(updateLastLoginQuery, [user.id], (err) => {
      if (err) {
        console.error('Error al actualizar last_login:', err);
        return res.status(500).json({ error: 'Error al actualizar la hora de inicio de sesión' });
      }
    });

    const updateStatusQuery = `UPDATE users SET status = 'ON' WHERE id = ?`;
    db.query(updateStatusQuery, [user.id], (err) => {
      if (err) {
        console.error('Error actualizando el status a ON:', err);
        return res.status(500).json({ error: 'Error al actualizar el estado del usuario' });
      }
    });

    // Obtener información del dispositivo (browser y sistema operativo)
    const agent = useragent.parse(req.headers['user-agent'] || '');
    const browser = agent.family || '';
    const os = agent.os.family || '';

    console.log('Datos del dispositivo:', { browser, os });

    // Verificar si ya existe una sesión para este usuario en este dispositivo
    const checkSessionQuery = `
      SELECT id FROM sesiones 
      WHERE user_uuid = ? AND browser = ? AND os = ?
      ORDER BY date_time_login DESC
      LIMIT 1
    `;
    db.query(checkSessionQuery, [user.uuid, browser, os], (checkErr, checkResults) => {
      if (checkErr) {
        console.error('Error al verificar sesión existente:', checkErr);
        // Si falla la verificación, procedemos a insertar una nueva sesión
        return insertNewSession();
      }

      if (checkResults.length > 0) {
        // Ya existe una sesión: actualizar la fecha de inicio
        const sessionId = checkResults[0].id;
        console.log('Sesión existente encontrada, ID:', sessionId);
        const updateSessionQuery = `UPDATE sesiones SET date_time_login = NOW() WHERE id = ?`;
        db.query(updateSessionQuery, [sessionId], (updateErr) => {
          if (updateErr) {
            console.error('Error al actualizar sesión existente:', updateErr);
          } else {
            console.log('Sesión actualizada exitosamente, ID:', sessionId);
          }
          return res.json({
            message: 'Login exitoso',
            userId: user.id,
            email: user.email,
            role: user.role_name,
            uuid: user.uuid,
          });
        });
      } else {
        // No existe sesión previa, insertar nueva
        return insertNewSession();
      }
    });

    function insertNewSession() {
      const insertSessionQuery = `
        INSERT INTO sesiones (
          user_uuid,
          date_time_login,
          browser,
          os
        ) VALUES (?, NOW(), ?, ?)
      `;
      db.query(
        insertSessionQuery,
        [user.uuid, browser, os],
        (sessErr, sessResult) => {
          if (sessErr) {
            console.error('Error insertando sesión:', sessErr);
            // No es fatal para el login, sólo registramos el error
          } else {
            console.log('Nueva sesión insertada, ID:', sessResult.insertId);
          }
          return res.json({
            message: 'Login exitoso',
            userId: user.id,
            email: user.email,
            role: user.role_name,
            uuid: user.uuid,
          });
        }
      );
    }
  });
});

// Nuevo endpoint: DELETE /api/sessions/:id
app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM sesiones WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error al borrar la sesión:', err);
      return res.status(500).json({ error: 'Error al borrar la sesión' });
    }
    // Se borra únicamente el registro de sesión con el ID proporcionado
    return res.json({ message: 'Sesión cerrada correctamente', clearLocalStorage: false });
  });
});



// [3] Endpoint de logout - Borra el registro de sesiones de la base de datos
app.post('/api/logout', (req, res) => {
  // Ahora esperamos que el front envíe user_uuid en lugar de userId
  const { user_uuid } = req.body;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Se requiere user_uuid para logout' });
  }
  const deleteSessionQuery = 'DELETE FROM sesiones WHERE user_uuid = ?';
  db.query(deleteSessionQuery, [user_uuid], (err) => {
    if (err) {
      console.error('Error borrando sesiones:', err);
      return res.status(500).json({ error: 'Error al borrar sesiones' });
    }
    return res.json({
      message: 'Logout exitoso',
      clearLocalStorage: true
    });
  });
});

// [4] Endpoint para obtener todos los usuarios
app.get('/api/users', (req, res) => {
  const query = `
    SELECT users.id, users.first_name, users.last_name, users.email, users.phone, 
           users.created_at, users.status, users.uuid, roles.name AS role_name
    FROM users
    INNER JOIN roles ON users.role_id = roles.id
  `;
  db.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Error en la consulta' });
    }
    return res.json(results);
  });
});

// [5] Endpoint para obtener el perfil del usuario
app.get('/api/user', (req, res) => {
  const { uuid } = req.query;
  if (!uuid) {
    return res.status(400).json({ error: 'UUID de usuario requerido' });
  }
  const query = `
    SELECT first_name, last_name, email, phone, address, profile_image
    FROM users
    WHERE uuid = ?
    LIMIT 1
  `;
  db.query(query, [uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo datos del usuario:', err);
      return res.status(500).json({ error: 'Error al obtener datos del usuario' });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    return res.json(results[0]);
  });
});

// [6] Endpoint para guardar/actualizar el perfil en la tabla users
app.post('/api/profile', upload.fields([]), (req, res) => {
  const { first_name, last_name, email, country_code, phone, address } = req.body;
  const user_uuid = req.headers.authorization;
  const checkEmailQuery = 'SELECT COUNT(*) AS count FROM users WHERE email = ? AND uuid != ?';
  db.query(checkEmailQuery, [email, user_uuid], (err, result) => {
    if (err) {
      console.error('Error al verificar el email:', err);
      return res.status(500).json({ error: 'Error al verificar el email' });
    }
    if (result[0].count > 0) {
      return res.status(400).json({ error: 'El email ya está en uso. Por favor elija otro.' });
    }
    const validCountryCode = country_code || '57';
    const updateUserQuery = `
      UPDATE users 
      SET 
        first_name = ?, 
        last_name = ?, 
        email = ?, 
        country_code = ?, 
        phone = ?, 
        address = ?
      WHERE uuid = ?
    `;
    db.query(
      updateUserQuery,
      [first_name, last_name, email, validCountryCode, phone, address, user_uuid],
      (err2) => {
        if (err2) {
          console.error('Error al actualizar el perfil:', err2);
          return res.status(500).json({ error: 'Error al actualizar el perfil' });
        }
        return res.json({ message: 'Perfil actualizado correctamente' });
      }
    );
  });
});

// [7] Endpoint para obtener el first_name del usuario
app.get('/api/user-profile', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Se requiere user_uuid' });
  }
  const query = 'SELECT first_name FROM users WHERE uuid = ?';
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo el perfil:', err);
      return res.status(500).json({ error: 'Error en la base de datos' });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    return res.json(results[0]);
  });
});

// [8] Endpoint para cambiar la contraseña
app.post('/api/change-password', (req, res) => {
  const { user_uuid, currentPassword, newPassword } = req.body;
  if (!user_uuid || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }
  const checkPasswordQuery = 'SELECT password FROM users WHERE uuid = ?';
  db.query(checkPasswordQuery, [user_uuid], (err, result) => {
    if (err) {
      console.error('Error al verificar la contraseña:', err);
      return res.status(500).json({ error: 'Error al verificar la contraseña' });
    }
    const user = result[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    bcrypt.compare(currentPassword, user.password, (err2, isMatch) => {
      if (err2) {
        console.error('Error comparando contraseñas:', err2);
        return res.status(500).json({ error: 'Error al comparar contraseñas' });
      }
      if (!isMatch) {
        return res.status(400).json({ error: 'Contraseña actual incorrecta' });
      }
      bcrypt.hash(newPassword, 10, (err3, hashedPassword) => {
        if (err3) {
          console.error('Error al hashear la contraseña:', err3);
          return res.status(500).json({ error: 'Error al hashear la contraseña' });
        }
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE uuid = ?';
        db.query(updatePasswordQuery, [hashedPassword, user_uuid], (err4) => {
          if (err4) {
            console.error('Error al actualizar la contraseña:', err4);
            return res.status(500).json({ error: 'Error al actualizar la contraseña' });
          }
          return res.json({ message: 'Contraseña actualizada correctamente' });
        });
      });
    });
  });
});

// [GET] Endpoint para productos
app.get('/api/products', (req, res) => {
  const query = 'SELECT * FROM products';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo productos:', err);
      return res.status(500).json({ error: 'Error obteniendo productos' });
    }
    res.json(results);
  });
});

// [9] Endpoint para obtener departamentos
app.get('/api/departments', (req, res) => {
  const query = 'SELECT id, name FROM departamentos';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo los departamentos:', err);
      return res.status(500).json({ error: 'Error obteniendo los departamentos' });
    }
    res.json(results);
  });
});

// [10] Endpoint para obtener ciudades de un departamento
app.get('/api/cities/:departmentId', (req, res) => {
  const { departmentId } = req.params;
  const query = 'SELECT id, nombre FROM ciudades WHERE departamento_id = ?';
  db.query(query, [departmentId], (err, results) => {
    if (err) {
      console.error('Error obteniendo las ciudades:', err);
      return res.status(500).json({ error: 'Error al obtener ciudades' });
    }
    res.json(results);
  });
});

// ============================
//  POST: Crear un cliente
// ============================
app.post('/api/clients', (req, res) => {
  const {
    name,
    lastName,
    phone,
    email,
    identification,
    address1,
    address2,
    department,
    city,
    user_uuid
  } = req.body;

  console.log('Recibiendo datos para nuevo cliente:', {
    name, lastName, phone, email, identification, address1, address2, department, city, user_uuid
  });

  if (!name || !lastName || !phone || !email || !user_uuid) {
    console.error('Faltan campos obligatorios o user_uuid.');
    return res.status(400).json({ error: 'Faltan campos obligatorios o user_uuid.' });
  }

  console.log('User UUID recibido:', user_uuid);

  const checkQuery = `SELECT COUNT(*) AS count FROM clientes WHERE correo = ?`;
  db.query(checkQuery, [email], (checkErr, checkResults) => {
    if (checkErr) {
      console.error('Error verificando correo:', checkErr);
      return res.status(500).json({ error: 'Error al verificar el correo.' });
    }
    console.log('Resultado de la verificación del correo:', checkResults[0]);
    if (checkResults[0].count > 0) {
      console.error('El correo ya está en uso.');
      return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
    }

    const insertClientQuery = `
      INSERT INTO clientes (
        nombre, 
        apellido, 
        telefono, 
        correo, 
        identificacion, 
        direccion1, 
        direccion2, 
        departamento_id, 
        ciudad_id,
        user_uuid,
        fecha_registro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    db.query(
      insertClientQuery,
      [
        name,
        lastName,
        phone,
        email,
        identification,
        address1,
        address2,
        department,
        city,
        user_uuid
      ],
      (err2, result) => {
        if (err2) {
          console.error('Error al insertar cliente:', err2);
          return res.status(500).json({ error: 'Error al insertar cliente' });
        }
        console.log('Cliente insertado correctamente, ID:', result.insertId);
        return res.json({
          message: 'Cliente insertado correctamente',
          clientId: result.insertId,
        });
      }
    );
  });
});

// ============================
//  GET: Obtener clientes
// ============================
app.get('/api/clients', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Se requiere user_uuid' });
  }
  const query = `
    SELECT 
      c.id,
      c.nombre,
      c.apellido,
      c.telefono,
      c.correo,
      c.identificacion,
      c.direccion1,
      c.direccion2,
      c.departamento_id,
      c.ciudad_id,
      c.fecha_registro,
      d.name AS department_name,
      ci.nombre AS city_name,
      u.first_name AS user_first_name,
      u.last_name AS user_last_name
    FROM clientes c
    LEFT JOIN departamentos d ON c.departamento_id = d.id
    LEFT JOIN ciudades ci ON c.ciudad_id = ci.id
    LEFT JOIN users u ON c.user_uuid = u.uuid
    WHERE c.user_uuid = ?
    ORDER BY c.id DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo clientes:', err);
      return res.status(500).json({ error: 'Error al obtener clientes' });
    }
    res.json(results);
  });
});

// ============================
//  PUT: Actualizar un cliente
// ============================
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const {
    nombre,
    apellido,
    telefono,
    correo,
    identificacion,
    direccion1,
    direccion2,
    departamento_id,
    ciudad_id
  } = req.body;
  const updateQuery = `
    UPDATE clientes 
    SET 
      nombre = ?, 
      apellido = ?, 
      telefono = ?, 
      correo = ?, 
      identificacion = ?, 
      direccion1 = ?, 
      direccion2 = ?, 
      departamento_id = ?, 
      ciudad_id = ?
    WHERE id = ?
  `;
  db.query(
    updateQuery,
    [
      nombre,
      apellido,
      telefono,
      correo,
      identificacion,
      direccion1,
      direccion2,
      departamento_id,
      ciudad_id,
      id
    ],
    (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.error('Error actualizando cliente (correo duplicado):', err);
          return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
        }
        console.error('Error updating client:', err);
        return res.status(500).json({ error: 'Error al actualizar cliente' });
      }
      return res.json({ message: 'Cliente actualizado correctamente' });
    }
  );
});

// ============================
//  DELETE: Eliminar un cliente
// ============================
app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM clientes WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error al borrar cliente:', err);
      return res.status(500).json({ error: 'Error al borrar cliente' });
    }
    return res.json({ message: 'Cliente borrado correctamente' });
  });
});

// ============================
//  GET: Obtener sesiones
// ============================
app.get('/api/sessions', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Falta user_uuid' });
  }
  const query = `
    SELECT 
      id,
      user_uuid,
      DATE_FORMAT(date_time_login, '%Y-%m-%d %H:%i:%s') AS date_time_login,
      browser,
      os
    FROM sesiones
    WHERE user_uuid = ?
    ORDER BY date_time_login DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo sesiones:', err);
      return res.status(500).json({ error: 'Error al obtener sesiones' });
    }
    res.json(results);
  });
});

// [8] Endpoint para cambiar la contraseña
app.post('/api/change-password', (req, res) => {
  const { user_uuid, currentPassword, newPassword } = req.body;
  if (!user_uuid || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }
  const checkPasswordQuery = 'SELECT password FROM users WHERE uuid = ?';
  db.query(checkPasswordQuery, [user_uuid], (err, result) => {
    if (err) {
      console.error('Error al verificar la contraseña:', err);
      return res.status(500).json({ error: 'Error al verificar la contraseña' });
    }
    const user = result[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    bcrypt.compare(currentPassword, user.password, (err2, isMatch) => {
      if (err2) {
        console.error('Error comparando contraseñas:', err2);
        return res.status(500).json({ error: 'Error al comparar contraseñas' });
      }
      if (!isMatch) {
        return res.status(400).json({ error: 'Contraseña actual incorrecta' });
      }
      bcrypt.hash(newPassword, 10, (err3, hashedPassword) => {
        if (err3) {
          console.error('Error al hashear la contraseña:', err3);
          return res.status(500).json({ error: 'Error al hashear la contraseña' });
        }
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE uuid = ?';
        db.query(updatePasswordQuery, [hashedPassword, user_uuid], (err4) => {
          if (err4) {
            console.error('Error al actualizar la contraseña:', err4);
            return res.status(500).json({ error: 'Error al actualizar la contraseña' });
          }
          return res.json({ message: 'Contraseña actualizada correctamente' });
        });
      });
    });
  });
});

// [GET] Endpoint para productos
app.get('/api/products', (req, res) => {
  const query = 'SELECT * FROM products';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo productos:', err);
      return res.status(500).json({ error: 'Error obteniendo productos' });
    }
    res.json(results);
  });
});

// [9] Endpoint para obtener departamentos
app.get('/api/departments', (req, res) => {
  const query = 'SELECT id, name FROM departamentos';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo los departamentos:', err);
      return res.status(500).json({ error: 'Error obteniendo los departamentos' });
    }
    res.json(results);
  });
});

// [10] Endpoint para obtener ciudades de un departamento
app.get('/api/cities/:departmentId', (req, res) => {
  const { departmentId } = req.params;
  const query = 'SELECT id, nombre FROM ciudades WHERE departamento_id = ?';
  db.query(query, [departmentId], (err, results) => {
    if (err) {
      console.error('Error obteniendo las ciudades:', err);
      return res.status(500).json({ error: 'Error al obtener ciudades' });
    }
    res.json(results);
  });
});

// ============================
//  POST: Crear un cliente
// ============================
app.post('/api/clients', (req, res) => {
  const {
    name,
    lastName,
    phone,
    email,
    identification,
    address1,
    address2,
    department,
    city,
    user_uuid
  } = req.body;

  console.log('Recibiendo datos para nuevo cliente:', {
    name, lastName, phone, email, identification, address1, address2, department, city, user_uuid
  });

  if (!name || !lastName || !phone || !email || !user_uuid) {
    console.error('Faltan campos obligatorios o user_uuid.');
    return res.status(400).json({ error: 'Faltan campos obligatorios o user_uuid.' });
  }

  console.log('User UUID recibido:', user_uuid);

  const checkQuery = `SELECT COUNT(*) AS count FROM clientes WHERE correo = ?`;
  db.query(checkQuery, [email], (checkErr, checkResults) => {
    if (checkErr) {
      console.error('Error verificando correo:', checkErr);
      return res.status(500).json({ error: 'Error al verificar el correo.' });
    }
    console.log('Resultado de la verificación del correo:', checkResults[0]);
    if (checkResults[0].count > 0) {
      console.error('El correo ya está en uso.');
      return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
    }

    const insertClientQuery = `
      INSERT INTO clientes (
        nombre, 
        apellido, 
        telefono, 
        correo, 
        identificacion, 
        direccion1, 
        direccion2, 
        departamento_id, 
        ciudad_id,
        user_uuid,
        fecha_registro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    db.query(
      insertClientQuery,
      [
        name,
        lastName,
        phone,
        email,
        identification,
        address1,
        address2,
        department,
        city,
        user_uuid
      ],
      (err2, result) => {
        if (err2) {
          console.error('Error al insertar cliente:', err2);
          return res.status(500).json({ error: 'Error al insertar cliente' });
        }
        console.log('Cliente insertado correctamente, ID:', result.insertId);
        return res.json({
          message: 'Cliente insertado correctamente',
          clientId: result.insertId,
        });
      }
    );
  });
});

// ============================
//  GET: Obtener clientes
// ============================
app.get('/api/clients', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Se requiere user_uuid' });
  }
  const query = `
    SELECT 
      c.id,
      c.nombre,
      c.apellido,
      c.telefono,
      c.correo,
      c.identificacion,
      c.direccion1,
      c.direccion2,
      c.departamento_id,
      c.ciudad_id,
      c.fecha_registro,
      d.name AS department_name,
      ci.nombre AS city_name,
      u.first_name AS user_first_name,
      u.last_name AS user_last_name
    FROM clientes c
    LEFT JOIN departamentos d ON c.departamento_id = d.id
    LEFT JOIN ciudades ci ON c.ciudad_id = ci.id
    LEFT JOIN users u ON c.user_uuid = u.uuid
    WHERE c.user_uuid = ?
    ORDER BY c.id DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo clientes:', err);
      return res.status(500).json({ error: 'Error al obtener clientes' });
    }
    res.json(results);
  });
});

// ============================
//  PUT: Actualizar un cliente
// ============================
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const {
    nombre,
    apellido,
    telefono,
    correo,
    identificacion,
    direccion1,
    direccion2,
    departamento_id,
    ciudad_id
  } = req.body;
  const updateQuery = `
    UPDATE clientes 
    SET 
      nombre = ?, 
      apellido = ?, 
      telefono = ?, 
      correo = ?, 
      identificacion = ?, 
      direccion1 = ?, 
      direccion2 = ?, 
      departamento_id = ?, 
      ciudad_id = ?
    WHERE id = ?
  `;
  db.query(
    updateQuery,
    [
      nombre,
      apellido,
      telefono,
      correo,
      identificacion,
      direccion1,
      direccion2,
      departamento_id,
      ciudad_id,
      id
    ],
    (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.error('Error actualizando cliente (correo duplicado):', err);
          return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
        }
        console.error('Error updating client:', err);
        return res.status(500).json({ error: 'Error al actualizar cliente' });
      }
      return res.json({ message: 'Cliente actualizado correctamente' });
    }
  );
});

// ============================
//  DELETE: Eliminar un cliente
// ============================
app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM clientes WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error al borrar cliente:', err);
      return res.status(500).json({ error: 'Error al borrar cliente' });
    }
    return res.json({ message: 'Cliente borrado correctamente' });
  });
});

// ============================
//  GET: Obtener sesiones
// ============================
app.get('/api/sessions', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Falta user_uuid' });
  }
  const query = `
    SELECT 
      id,
      user_uuid,
      DATE_FORMAT(date_time_login, '%Y-%m-%d %H:%i:%s') AS date_time_login,
      browser,
      os
    FROM sesiones
    WHERE user_uuid = ?
    ORDER BY date_time_login DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo sesiones:', err);
      return res.status(500).json({ error: 'Error al obtener sesiones' });
    }
    res.json(results);
  });
});

// [8] Endpoint para cambiar la contraseña
app.post('/api/change-password', (req, res) => {
  const { user_uuid, currentPassword, newPassword } = req.body;
  if (!user_uuid || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }
  const checkPasswordQuery = 'SELECT password FROM users WHERE uuid = ?';
  db.query(checkPasswordQuery, [user_uuid], (err, result) => {
    if (err) {
      console.error('Error al verificar la contraseña:', err);
      return res.status(500).json({ error: 'Error al verificar la contraseña' });
    }
    const user = result[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    bcrypt.compare(currentPassword, user.password, (err2, isMatch) => {
      if (err2) {
        console.error('Error comparando contraseñas:', err2);
        return res.status(500).json({ error: 'Error al comparar contraseñas' });
      }
      if (!isMatch) {
        return res.status(400).json({ error: 'Contraseña actual incorrecta' });
      }
      bcrypt.hash(newPassword, 10, (err3, hashedPassword) => {
        if (err3) {
          console.error('Error al hashear la contraseña:', err3);
          return res.status(500).json({ error: 'Error al hashear la contraseña' });
        }
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE uuid = ?';
        db.query(updatePasswordQuery, [hashedPassword, user_uuid], (err4) => {
          if (err4) {
            console.error('Error al actualizar la contraseña:', err4);
            return res.status(500).json({ error: 'Error al actualizar la contraseña' });
          }
          return res.json({ message: 'Contraseña actualizada correctamente' });
        });
      });
    });
  });
});

// [GET] Endpoint para productos
app.get('/api/products', (req, res) => {
  const query = 'SELECT * FROM products';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo productos:', err);
      return res.status(500).json({ error: 'Error obteniendo productos' });
    }
    res.json(results);
  });
});

// [9] Endpoint para obtener departamentos
app.get('/api/departments', (req, res) => {
  const query = 'SELECT id, name FROM departamentos';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo los departamentos:', err);
      return res.status(500).json({ error: 'Error obteniendo los departamentos' });
    }
    res.json(results);
  });
});

// [10] Endpoint para obtener ciudades de un departamento
app.get('/api/cities/:departmentId', (req, res) => {
  const { departmentId } = req.params;
  const query = 'SELECT id, nombre FROM ciudades WHERE departamento_id = ?';
  db.query(query, [departmentId], (err, results) => {
    if (err) {
      console.error('Error obteniendo las ciudades:', err);
      return res.status(500).json({ error: 'Error al obtener ciudades' });
    }
    res.json(results);
  });
});

// ============================
//  POST: Crear un cliente
// ============================
app.post('/api/clients', (req, res) => {
  const {
    name,
    lastName,
    phone,
    email,
    identification,
    address1,
    address2,
    department,
    city,
    user_uuid
  } = req.body;

  console.log('Recibiendo datos para nuevo cliente:', {
    name, lastName, phone, email, identification, address1, address2, department, city, user_uuid
  });

  if (!name || !lastName || !phone || !email || !user_uuid) {
    console.error('Faltan campos obligatorios o user_uuid.');
    return res.status(400).json({ error: 'Faltan campos obligatorios o user_uuid.' });
  }

  console.log('User UUID recibido:', user_uuid);

  const checkQuery = `SELECT COUNT(*) AS count FROM clientes WHERE correo = ?`;
  db.query(checkQuery, [email], (checkErr, checkResults) => {
    if (checkErr) {
      console.error('Error verificando correo:', checkErr);
      return res.status(500).json({ error: 'Error al verificar el correo.' });
    }
    console.log('Resultado de la verificación del correo:', checkResults[0]);
    if (checkResults[0].count > 0) {
      console.error('El correo ya está en uso.');
      return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
    }

    const insertClientQuery = `
      INSERT INTO clientes (
        nombre, 
        apellido, 
        telefono, 
        correo, 
        identificacion, 
        direccion1, 
        direccion2, 
        departamento_id, 
        ciudad_id,
        user_uuid,
        fecha_registro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    db.query(
      insertClientQuery,
      [
        name,
        lastName,
        phone,
        email,
        identification,
        address1,
        address2,
        department,
        city,
        user_uuid
      ],
      (err2, result) => {
        if (err2) {
          console.error('Error al insertar cliente:', err2);
          return res.status(500).json({ error: 'Error al insertar cliente' });
        }
        console.log('Cliente insertado correctamente, ID:', result.insertId);
        return res.json({
          message: 'Cliente insertado correctamente',
          clientId: result.insertId,
        });
      }
    );
  });
});

// ============================
//  GET: Obtener clientes
// ============================
app.get('/api/clients', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Se requiere user_uuid' });
  }
  const query = `
    SELECT 
      c.id,
      c.nombre,
      c.apellido,
      c.telefono,
      c.correo,
      c.identificacion,
      c.direccion1,
      c.direccion2,
      c.departamento_id,
      c.ciudad_id,
      c.fecha_registro,
      d.name AS department_name,
      ci.nombre AS city_name,
      u.first_name AS user_first_name,
      u.last_name AS user_last_name
    FROM clientes c
    LEFT JOIN departamentos d ON c.departamento_id = d.id
    LEFT JOIN ciudades ci ON c.ciudad_id = ci.id
    LEFT JOIN users u ON c.user_uuid = u.uuid
    WHERE c.user_uuid = ?
    ORDER BY c.id DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo clientes:', err);
      return res.status(500).json({ error: 'Error al obtener clientes' });
    }
    res.json(results);
  });
});

// ============================
//  PUT: Actualizar un cliente
// ============================
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const {
    nombre,
    apellido,
    telefono,
    correo,
    identificacion,
    direccion1,
    direccion2,
    departamento_id,
    ciudad_id
  } = req.body;
  const updateQuery = `
    UPDATE clientes 
    SET 
      nombre = ?, 
      apellido = ?, 
      telefono = ?, 
      correo = ?, 
      identificacion = ?, 
      direccion1 = ?, 
      direccion2 = ?, 
      departamento_id = ?, 
      ciudad_id = ?
    WHERE id = ?
  `;
  db.query(
    updateQuery,
    [
      nombre,
      apellido,
      telefono,
      correo,
      identificacion,
      direccion1,
      direccion2,
      departamento_id,
      ciudad_id,
      id
    ],
    (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.error('Error actualizando cliente (correo duplicado):', err);
          return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
        }
        console.error('Error updating client:', err);
        return res.status(500).json({ error: 'Error al actualizar cliente' });
      }
      return res.json({ message: 'Cliente actualizado correctamente' });
    }
  );
});

// ============================
//  DELETE: Eliminar un cliente
// ============================
app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM clientes WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error al borrar cliente:', err);
      return res.status(500).json({ error: 'Error al borrar cliente' });
    }
    return res.json({ message: 'Cliente borrado correctamente' });
  });
});

// ============================
//  GET: Obtener sesiones
// ============================
app.get('/api/sessions', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Falta user_uuid' });
  }
  const query = `
    SELECT 
      id,
      user_uuid,
      DATE_FORMAT(date_time_login, '%Y-%m-%d %H:%i:%s') AS date_time_login,
      browser,
      os
    FROM sesiones
    WHERE user_uuid = ?
    ORDER BY date_time_login DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo sesiones:', err);
      return res.status(500).json({ error: 'Error al obtener sesiones' });
    }
    res.json(results);
  });
});

// [8] Endpoint para cambiar la contraseña
app.post('/api/change-password', (req, res) => {
  const { user_uuid, currentPassword, newPassword } = req.body;
  if (!user_uuid || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }
  const checkPasswordQuery = 'SELECT password FROM users WHERE uuid = ?';
  db.query(checkPasswordQuery, [user_uuid], (err, result) => {
    if (err) {
      console.error('Error al verificar la contraseña:', err);
      return res.status(500).json({ error: 'Error al verificar la contraseña' });
    }
    const user = result[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    bcrypt.compare(currentPassword, user.password, (err2, isMatch) => {
      if (err2) {
        console.error('Error comparando contraseñas:', err2);
        return res.status(500).json({ error: 'Error al comparar contraseñas' });
      }
      if (!isMatch) {
        return res.status(400).json({ error: 'Contraseña actual incorrecta' });
      }
      bcrypt.hash(newPassword, 10, (err3, hashedPassword) => {
        if (err3) {
          console.error('Error al hashear la contraseña:', err3);
          return res.status(500).json({ error: 'Error al hashear la contraseña' });
        }
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE uuid = ?';
        db.query(updatePasswordQuery, [hashedPassword, user_uuid], (err4) => {
          if (err4) {
            console.error('Error al actualizar la contraseña:', err4);
            return res.status(500).json({ error: 'Error al actualizar la contraseña' });
          }
          return res.json({ message: 'Contraseña actualizada correctamente' });
        });
      });
    });
  });
});

// [GET] Endpoint para productos
app.get('/api/products', (req, res) => {
  const query = 'SELECT * FROM products';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo productos:', err);
      return res.status(500).json({ error: 'Error obteniendo productos' });
    }
    res.json(results);
  });
});

// [9] Endpoint para obtener departamentos
app.get('/api/departments', (req, res) => {
  const query = 'SELECT id, name FROM departamentos';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo los departamentos:', err);
      return res.status(500).json({ error: 'Error obteniendo los departamentos' });
    }
    res.json(results);
  });
});

// [10] Endpoint para obtener ciudades de un departamento
app.get('/api/cities/:departmentId', (req, res) => {
  const { departmentId } = req.params;
  const query = 'SELECT id, nombre FROM ciudades WHERE departamento_id = ?';
  db.query(query, [departmentId], (err, results) => {
    if (err) {
      console.error('Error obteniendo las ciudades:', err);
      return res.status(500).json({ error: 'Error al obtener ciudades' });
    }
    res.json(results);
  });
});

// ============================
//  POST: Crear un cliente
// ============================
app.post('/api/clients', (req, res) => {
  const {
    name,
    lastName,
    phone,
    email,
    identification,
    address1,
    address2,
    department,
    city,
    user_uuid
  } = req.body;

  console.log('Recibiendo datos para nuevo cliente:', {
    name, lastName, phone, email, identification, address1, address2, department, city, user_uuid
  });

  if (!name || !lastName || !phone || !email || !user_uuid) {
    console.error('Faltan campos obligatorios o user_uuid.');
    return res.status(400).json({ error: 'Faltan campos obligatorios o user_uuid.' });
  }

  console.log('User UUID recibido:', user_uuid);

  const checkQuery = `SELECT COUNT(*) AS count FROM clientes WHERE correo = ?`;
  db.query(checkQuery, [email], (checkErr, checkResults) => {
    if (checkErr) {
      console.error('Error verificando correo:', checkErr);
      return res.status(500).json({ error: 'Error al verificar el correo.' });
    }
    console.log('Resultado de la verificación del correo:', checkResults[0]);
    if (checkResults[0].count > 0) {
      console.error('El correo ya está en uso.');
      return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
    }

    const insertClientQuery = `
      INSERT INTO clientes (
        nombre, 
        apellido, 
        telefono, 
        correo, 
        identificacion, 
        direccion1, 
        direccion2, 
        departamento_id, 
        ciudad_id,
        user_uuid,
        fecha_registro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    db.query(
      insertClientQuery,
      [
        name,
        lastName,
        phone,
        email,
        identification,
        address1,
        address2,
        department,
        city,
        user_uuid
      ],
      (err2, result) => {
        if (err2) {
          console.error('Error al insertar cliente:', err2);
          return res.status(500).json({ error: 'Error al insertar cliente' });
        }
        console.log('Cliente insertado correctamente, ID:', result.insertId);
        return res.json({
          message: 'Cliente insertado correctamente',
          clientId: result.insertId,
        });
      }
    );
  });
});

// ============================
//  GET: Obtener clientes
// ============================
app.get('/api/clients', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Se requiere user_uuid' });
  }
  const query = `
    SELECT 
      c.id,
      c.nombre,
      c.apellido,
      c.telefono,
      c.correo,
      c.identificacion,
      c.direccion1,
      c.direccion2,
      c.departamento_id,
      c.ciudad_id,
      c.fecha_registro,
      d.name AS department_name,
      ci.nombre AS city_name,
      u.first_name AS user_first_name,
      u.last_name AS user_last_name
    FROM clientes c
    LEFT JOIN departamentos d ON c.departamento_id = d.id
    LEFT JOIN ciudades ci ON c.ciudad_id = ci.id
    LEFT JOIN users u ON c.user_uuid = u.uuid
    WHERE c.user_uuid = ?
    ORDER BY c.id DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo clientes:', err);
      return res.status(500).json({ error: 'Error al obtener clientes' });
    }
    res.json(results);
  });
});

// ============================
//  PUT: Actualizar un cliente
// ============================
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const {
    nombre,
    apellido,
    telefono,
    correo,
    identificacion,
    direccion1,
    direccion2,
    departamento_id,
    ciudad_id
  } = req.body;
  const updateQuery = `
    UPDATE clientes 
    SET 
      nombre = ?, 
      apellido = ?, 
      telefono = ?, 
      correo = ?, 
      identificacion = ?, 
      direccion1 = ?, 
      direccion2 = ?, 
      departamento_id = ?, 
      ciudad_id = ?
    WHERE id = ?
  `;
  db.query(
    updateQuery,
    [
      nombre,
      apellido,
      telefono,
      correo,
      identificacion,
      direccion1,
      direccion2,
      departamento_id,
      ciudad_id,
      id
    ],
    (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.error('Error actualizando cliente (correo duplicado):', err);
          return res.status(400).json({ error: 'El correo ya está en uso. Use otro.' });
        }
        console.error('Error updating client:', err);
        return res.status(500).json({ error: 'Error al actualizar cliente' });
      }
      return res.json({ message: 'Cliente actualizado correctamente' });
    }
  );
});

// ============================
//  DELETE: Eliminar un cliente
// ============================
app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM clientes WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error al borrar cliente:', err);
      return res.status(500).json({ error: 'Error al borrar cliente' });
    }
    return res.json({ message: 'Cliente borrado correctamente' });
  });
});

// ============================
//  GET: Obtener sesiones
// ============================
app.get('/api/sessions', (req, res) => {
  const { user_uuid } = req.query;
  if (!user_uuid) {
    return res.status(400).json({ error: 'Falta user_uuid' });
  }
  const query = `
    SELECT 
      id,
      user_uuid,
      DATE_FORMAT(date_time_login, '%Y-%m-%d %H:%i:%s') AS date_time_login,
      browser,
      os
    FROM sesiones
    WHERE user_uuid = ?
    ORDER BY date_time_login DESC
  `;
  db.query(query, [user_uuid], (err, results) => {
    if (err) {
      console.error('Error obteniendo sesiones:', err);
      return res.status(500).json({ error: 'Error al obtener sesiones' });
    }
    res.json(results);
  });
});


// [8] Endpoint para cambiar la contraseña
app.post('/api/change-password', (req, res) => {
  const { user_uuid, currentPassword, newPassword } = req.body;
  if (!user_uuid || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }
  const checkPasswordQuery = 'SELECT password FROM users WHERE uuid = ?';
  db.query(checkPasswordQuery, [user_uuid], (err, result) => {
    if (err) {
      console.error('Error al verificar la contraseña:', err);
      return res.status(500).json({ error: 'Error al verificar la contraseña' });
    }
    const user = result[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    bcrypt.compare(currentPassword, user.password, (err2, isMatch) => {
      if (err2) {
        console.error('Error comparando contraseñas:', err2);
        return res.status(500).json({ error: 'Error al comparar contraseñas' });
      }
      if (!isMatch) {
        return res.status(400).json({ error: 'Contraseña actual incorrecta' });
      }
      bcrypt.hash(newPassword, 10, (err3, hashedPassword) => {
        if (err3) {
          console.error('Error al hashear la contraseña:', err3);
          return res.status(500).json({ error: 'Error al hashear la contraseña' });
        }
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE uuid = ?';
        db.query(updatePasswordQuery, [hashedPassword, user_uuid], (err4) => {
          if (err4) {
            console.error('Error al actualizar la contraseña:', err4);
            return res.status(500).json({ error: 'Error al actualizar la contraseña' });
          }
          return res.json({ message: 'Contraseña actualizada correctamente' });
        });
      });
    });
  });
});

// [GET] Endpoint para productos
app.get('/api/products', (req, res) => {
  const query = 'SELECT * FROM products';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo productos:', err);
      return res.status(500).json({ error: 'Error obteniendo productos' });
    }
    res.json(results);
  });
});

// [9] Endpoint para obtener departamentos
app.get('/api/departments', (req, res) => {
  const query = 'SELECT id, name FROM departamentos';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error obteniendo los departamentos:', err);
      return res.status(500).json({ error: 'Error obteniendo los departamentos' });
    }
    res.json(results);
  });
});

// [10] Endpoint para obtener ciudades de un departamento
app.get('/api/cities/:departmentId', (req, res) => {
  const { departmentId } = req.params;
  const query = 'SELECT id, nombre FROM ciudades WHERE departamento_id = ?';
  db.query(query, [departmentId], (err, results) => {
    if (err) {
      console.error('Error obteniendo las ciudades:', err);
      return res.status(500).json({ error: 'Error al obtener ciudades' });
    }
    res.json(results);
  });
});

// ============================
// INICIAR SERVER
// ============================
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
