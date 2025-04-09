import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import bcrypt from 'bcrypt';
import pg from 'pg';

const { Pool } = pg;

// Sistema de debug aprimorado
const debug = {
  startup: (...args) => console.log('🔧 [STARTUP]', ...args),
  db: (...args) => console.log('🗄️ [DATABASE]', ...args),
  route: (...args) => console.log('🛣️ [ROUTE]', ...args),
  error: (...args) => console.error('🚨 [ERROR]', ...args),
  env: (...args) => console.log('🌿 [ENV]', ...args),
  auth: (...args) => console.log('🔐 [AUTH]', ...args)
};

// Middleware de autenticação JWT (definido antes de ser usado)
const authenticate = (req, res, next) => {
  debug.auth('Iniciando autenticação');
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  
  if (!token) {
    debug.auth('Falha: Token não fornecido');
    return res.status(401).json({ error: 'Token de acesso não fornecido' });
  }

  jwt.verify(token, process.env.SECRET_KEY, (err, user) => {
    if (err) {
      debug.auth(`Falha: Token inválido (${err.message})`);
      return res.status(403).json({ error: 'Token inválido ou expirado' });
    }
    
    debug.auth(`Autenticação bem-sucedida para usuário: ${user.email}`);
    req.user = user;
    next();
  });
};

(async () => {
  try {
    debug.startup('Iniciando servidor...');
    
    // Configuração de ambiente
    dotenv.config();
    debug.env('Variáveis de ambiente carregadas');
    
    // Validação de variáveis essenciais
    const requiredEnvVars = ['PORT', 'SECRET_KEY', 'NEON_DATABASE_URL', 'FRONTEND_URL'];
    debug.env('Verificando variáveis obrigatórias:', requiredEnvVars);
    
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        debug.error(`Variável faltando: ${envVar}`);
        throw new Error(`Variável de ambiente ${envVar} não configurada`);
      }
    }

    // Inicialização do Express
    const app = express();
    const PORT = process.env.PORT || 4000;
    debug.startup(`Configurando servidor na porta ${PORT}`);

    // Configuração do pool PostgreSQL
    const poolConfig = {
      connectionString: process.env.NEON_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    };
    
    debug.db('Configuração do pool:', {
      ...poolConfig,
      connectionString: poolConfig.connectionString 
        ? `${poolConfig.connectionString.substring(0, 30)}...` 
        : 'UNDEFINED'
    });

    const pool = new Pool(poolConfig);

    // Teste de conexão com o banco de dados
    try {
      debug.db('Testando conexão com o banco...');
      const client = await pool.connect();
      const dbResult = await client.query('SELECT NOW()');
      client.release();
      debug.db('Conexão bem-sucedida. Hora do banco:', dbResult.rows[0].now);
    } catch (dbError) {
      debug.error('Falha na conexão com o banco:', {
        message: dbError.message,
        code: dbError.code,
        stack: dbError.stack
      });
      process.exit(1);
    }

    // Middlewares
    app.use(express.json());
    debug.startup('Middleware express.json() configurado');
    
    app.use(cors({
      origin: process.env.FRONTEND_URL,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true
    }));
    debug.startup(`CORS configurado para ${process.env.FRONTEND_URL}`);

    app.use(morgan('dev'));
    debug.startup('Morgan logger configurado');

    // Rotas básicas
    app.get('/favicon.ico', (req, res) => {
      debug.route('Requisição de favicon recebida');
      res.status(204).end();
    });
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
  console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`); // Corrigido aqui
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