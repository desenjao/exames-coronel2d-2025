import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import bcrypt from 'bcrypt';
import pg from 'pg';
const { Pool } = pg;

// Configuração assíncrona
(async () => {
  try {
    // Carrega variáveis de ambiente
    dotenv.config();
    
    // Validação das variáveis essenciais
    const requiredEnvVars = ['PORT', 'SECRET_KEY', 'NEON_DATABASE_URL', 'FRONTEND_URL'];
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Variável de ambiente ${envVar} não configurada`);
      }
    }

    // Configurações do servidor
    const app = express();
    const PORT = process.env.PORT || 4000;
    const SECRET_KEY = process.env.SECRET_KEY;
    const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS) || 10;
    const FRONTEND_URL = process.env.FRONTEND_URL;

    // Pool de conexões com Neon PostgreSQL
    const pool = new Pool({
      connectionString: process.env.NEON_DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    });

    // Teste de conexão com o banco
    try {
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ Conexão com o Neon PostgreSQL estabelecida');
    } catch (dbError) {
      console.error('❌ Falha na conexão com o Neon:', dbError.message);
      process.exit(1);
    }

    // Middlewares
    app.use(express.json());
    app.use(cors({
      origin: FRONTEND_URL,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true
    }));
    app.use(morgan('dev'));

    // Middleware de autenticação JWT
    const authenticate = (req, res, next) => {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      
      if (!token) return res.status(401).json({ error: 'Token de acesso não fornecido' });

      jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido ou expirado' });
        req.user = user;
        next();
      });
    };
    app.get('/', async (req, res) => {
      res.send('ta rodando o bixão')
    });

    // Rota de saúde do servidor
    app.get('/api/health', async (req, res) => {
      try {
        const dbResult = await pool.query('SELECT NOW()');
        res.json({
          status: 'operacional',
          environment: process.env.NODE_ENV || 'development',
          timestamp: new Date().toISOString(),
          database: {
            status: 'conectado',
            timestamp: dbResult.rows[0].now
          }
        });
      } catch (err) {
        res.status(503).json({
          status: 'indisponível',
          error: 'Falha na conexão com o banco de dados'
        });
      }
    });

    // Rotas de autenticação
    app.post('/api/auth/register', async (req, res) => {
      try {
        const { email, password } = req.body;
        
        if (!email || !password) {
          return res.status(400).json({ 
            error: 'Email e senha são obrigatórios',
            details: {
              ...(!email && { email: 'Campo obrigatório' }),
              ...(!password && { password: 'Campo obrigatório' })
            }
          });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await pool.query(
          'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at',
          [email, hashedPassword]
        );

        const token = jwt.sign(
          { id: result.rows[0].id, email: result.rows[0].email },
          SECRET_KEY,
          { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
        );

        res.status(201).json({
          message: 'Usuário registrado com sucesso',
          user: result.rows[0],
          token
        });
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: 'Email já está em uso' });
        }
        console.error('Erro no registro:', err);
        res.status(500).json({ error: 'Erro durante o registro' });
      }
    });

    app.post('/api/auth/login', async (req, res) => {
      try {
        const { email, password } = req.body;
    
        // Validação básica dos campos
        if (!email?.trim() || !password?.trim()) {
          return res.status(400).json({ 
            error: 'Credenciais inválidas',
            details: {
              ...(!email?.trim() && { email: 'O email é obrigatório' }),
              ...(!password?.trim() && { password: 'A senha é obrigatória' })
            }
          });
        }
    
        // Consulta ao banco de dados
        const result = await pool.query(
          `SELECT 
            id, email, password, name, 
            role, is_admin, department,
            created_at, is_active
           FROM users 
           WHERE LOWER(email) = LOWER($1)`,
          [email.trim()]
        );
    
        const user = result.rows[0];
    
        // Verificações
        if (!user) {
          return res.status(401).json({ 
            error: 'Credenciais inválidas',
            details: { email: 'Nenhuma conta encontrada com este email' }
          });
        }
    
        if (!user.is_active) {
          return res.status(403).json({ 
            error: 'Conta desativada',
            details: { email: 'Sua conta está desativada' }
          });
        }
    
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
          return res.status(401).json({ 
            error: 'Credenciais inválidas',
            details: { password: 'Senha incorreta' }
          });
        }
    
        // Atualiza último login
        await pool.query(
          'UPDATE users SET last_login = NOW() WHERE id = $1',
          [user.id]
        );
    
        // Gera token JWT
        const token = jwt.sign(
          {
            id: user.id,
            email: user.email,
            role: user.role,
            is_admin: user.is_admin
          },
          process.env.SECRET_KEY,
          { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
        );
    
        // Resposta de sucesso
        res.json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            is_admin: user.is_admin,
            department: user.department
          },
          token
        });
    
      } catch (err) {
        console.error('Erro no login:', err);
        res.status(500).json({
          error: 'Erro interno no servidor',
          ...(process.env.NODE_ENV === 'development' && {
            details: err.message
          })
        });
      }
    });
    // Rotas protegidas de pacientes
    app.get('/api/pacientes', authenticate, async (req, res) => {
      try {
        const { search } = req.query;
        let query = 'SELECT * FROM patients';
        const params = [];
        
        if (search) {
          query += ' WHERE full_name ILIKE $1 OR cpf ILIKE $1';
          params.push(`%${search}%`);
        }
        
        query += ' ORDER BY created_at DESC LIMIT 100';
        const result = await pool.query(query, params);
        
        res.json({
          count: result.rowCount,
          data: result.rows
        });
      } catch (err) {
        console.error('Erro ao buscar pacientes:', err);
        res.status(500).json({ error: 'Erro ao buscar pacientes' });
      }
    });

    // Inicialização do servidor
    const server = app.listen(PORT, () => {
      console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🔗 Ambiente: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 Frontend: ${FRONTEND_URL}`);
      console.log(`💾 Banco de dados: Neon PostgreSQL\n`);
    });

    // Gerenciamento de shutdown
    process.on('SIGTERM', () => {
      console.log('\n🛑 Recebido SIGTERM. Encerrando servidor...');
      server.close(() => {
        pool.end(() => {
          console.log('♻️ Servidor e conexões encerrados corretamente');
          process.exit(0);
        });
      });
    });

  } catch (startupError) {
    console.error('\n❌ Falha crítica na inicialização:', startupError.message);
    process.exit(1);
  }
})();