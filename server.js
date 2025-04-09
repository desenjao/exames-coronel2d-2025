<<<<<<< HEAD
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
=======
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
const porta = process.env.PORT || 3000;

// Middleware


app.use(cors({
  origin: [
    '*'
  ],
  credentials: true, // Se estiver usando cookies/auth
  methods: ['GET', 'POST', 'PUT', 'DELETE']
}));
app.use(bodyParser.json());
// Conexão com o banco de dados Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Testar conexão com o banco de dados
pool.connect((erro, cliente, liberar) => {
  if (erro) {
    return console.error('Erro ao conectar ao banco de dados:', erro);
  }
  console.log('Conexão com o banco de dados estabelecida com sucesso!');
  liberar();
});

// Middleware para tratamento de erros
app.use((erro, req, res, next) => {
  console.error(erro.stack);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// Rotas da API
app.get('/', async (req, res) => {
    try {
      // Teste simples no banco — pode ser uma consulta leve
      const result = await pool.query('SELECT NOW()');
  
      res.status(200).json({
        status: 'ok',
        message: 'Servidor e banco de dados funcionando!',
        db_time: result.rows[0].now,
      });
    } catch (error) {
      console.error('Erro de conexão com o banco:', error);
      res.status(500).json({
        status: 'error',
        message: 'Erro ao conectar com o banco de dados.',
        error: error.message,
      });
    }
  });
  
// ===== PACIENTES =====

// Listar todos os pacientes
app.get('/api/pacientes', async (req, res) => {
  try {
    const { consulta } = req.query;
    
    let textoConsulta = 'SELECT * FROM patients ORDER BY full_name';
    let parametrosConsulta = [];
    
    if (consulta) {
      textoConsulta = `
        SELECT * FROM patients 
        WHERE full_name ILIKE $1 
        OR cpf ILIKE $1 
        OR sus_card ILIKE $1 
        ORDER BY full_name
      `;
      parametrosConsulta = [`%${consulta}%`];
    }
    
    const resultado = await pool.query(textoConsulta, parametrosConsulta);
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar pacientes:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Obter paciente por ID
app.get('/api/pacientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query('SELECT * FROM patients WHERE id = $1', [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Paciente não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao buscar paciente:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Criar novo paciente
app.post('/api/pacientes', async (req, res) => {
  try {
    const {
      nome_completo,
      cpf,
      cartao_sus,
      data_nascimento,
      sexo,
      endereco,
      telefone,
      nome_mae,
      profissao,
      escolaridade,
      numero_prontuario,
      gestante,
      hipertenso,
      diabetico,
      outros_grupos,
      observacoes
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `INSERT INTO patients (
        full_name, cpf, sus_card, birth_date, gender, address, phone, 
        mother_name, profession, education, record_number, is_pregnant, 
        is_hypertensive, is_diabetic, other_groups, observations, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) 
      RETURNING *`,
      [
        nome_completo, cpf, cartao_sus, data_nascimento, sexo, endereco, telefone, 
        nome_mae, profissao, escolaridade, numero_prontuario, 
        gestante || false, hipertenso || false, diabetico || false, 
        outros_grupos, observacoes, agora, agora
      ]
    );
    
    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao criar paciente:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Atualizar paciente
app.put('/api/pacientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nome_completo,
      cpf,
      cartao_sus,
      data_nascimento,
      sexo,
      endereco,
      telefone,
      nome_mae,
      profissao,
      escolaridade,
      numero_prontuario,
      gestante,
      hipertenso,
      diabetico,
      outros_grupos,
      observacoes
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `UPDATE patients SET 
        full_name = $1, 
        cpf = $2, 
        sus_card = $3, 
        birth_date = $4, 
        gender = $5, 
        address = $6, 
        phone = $7, 
        mother_name = $8, 
        profession = $9, 
        education = $10, 
        record_number = $11, 
        is_pregnant = $12, 
        is_hypertensive = $13, 
        is_diabetic = $14, 
        other_groups = $15, 
        observations = $16, 
        updated_at = $17
      WHERE id = $18 
      RETURNING *`,
      [
        nome_completo, cpf, cartao_sus, data_nascimento, sexo, endereco, telefone, 
        nome_mae, profissao, escolaridade, numero_prontuario, 
        gestante, hipertenso, diabetico, 
        outros_grupos, observacoes, agora, id
      ]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Paciente não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao atualizar paciente:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Excluir paciente
app.delete('/api/pacientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query('DELETE FROM patients WHERE id = $1 RETURNING *', [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Paciente não encontrado' });
    }
    
    res.json({ sucesso: true, mensagem: 'Paciente excluído com sucesso' });
  } catch (erro) {
    console.error('Erro ao excluir paciente:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// ===== EXAMES =====

// Listar todos os exames
app.get('/api/exames', async (req, res) => {
  try {
    const { pacienteId, status, tipoExame } = req.query;
    
    let textoConsulta = `
      SELECT e.*, p.full_name as nome_paciente 
      FROM exams e
      JOIN patients p ON e.patient_id = p.id
    `;
    
    const parametrosConsulta = [];
    const condicoes = [];
    
    if (pacienteId) {
      condicoes.push(`e.patient_id = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(pacienteId);
    }
    
    if (status) {
      condicoes.push(`e.status = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(status);
    }
    
    if (tipoExame) {
      condicoes.push(`e.exam_type = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(tipoExame);
    }
    
    if (condicoes.length > 0) {
      textoConsulta += ' WHERE ' + condicoes.join(' AND ');
    }
    
    textoConsulta += ' ORDER BY e.scheduled_date DESC';
    
    const resultado = await pool.query(textoConsulta, parametrosConsulta);
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar exames:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Obter exame por ID
app.get('/api/exames/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const resultado = await pool.query(`
      SELECT e.*, p.full_name as nome_paciente 
      FROM exams e
      JOIN patients p ON e.patient_id = p.id
      WHERE e.id = $1
    `, [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Exame não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao buscar exame:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Criar novo exame
app.post('/api/exames', async (req, res) => {
  try {
    const {
      paciente_id,
      tipo_exame,
      data_agendada,
      status,
      url_resultado,
      texto_resultado,
      observacoes
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `INSERT INTO exams (
        patient_id, exam_type, scheduled_date, status, 
        result_url, result_text, observations, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
      RETURNING *`,
      [
        paciente_id, tipo_exame, data_agendada, status, 
        url_resultado, texto_resultado, observacoes, agora, agora
      ]
    );
    
    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao criar exame:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Atualizar exame
app.put('/api/exames/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      paciente_id,
      tipo_exame,
      data_agendada,
      status,
      url_resultado,
      texto_resultado,
      observacoes
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `UPDATE exams SET 
        patient_id = $1, 
        exam_type = $2, 
        scheduled_date = $3, 
        status = $4, 
        result_url = $5, 
        result_text = $6, 
        observations = $7, 
        updated_at = $8
      WHERE id = $9 
      RETURNING *`,
      [
        paciente_id, tipo_exame, data_agendada, status, 
        url_resultado, texto_resultado, observacoes, agora, id
      ]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Exame não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao atualizar exame:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Excluir exame
app.delete('/api/exames/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query('DELETE FROM exams WHERE id = $1 RETURNING *', [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Exame não encontrado' });
    }
    
    res.json({ sucesso: true, mensagem: 'Exame excluído com sucesso' });
  } catch (erro) {
    console.error('Erro ao excluir exame:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// ===== GESTANTES =====

// Listar acompanhamentos de gestantes
app.get('/api/gestantes', async (req, res) => {
  try {
    const { pacienteId } = req.query;
    
    let textoConsulta = `
      SELECT pm.*, p.full_name as nome_paciente 
      FROM pregnancy_monitoring pm
      JOIN patients p ON pm.patient_id = p.id
    `;
    
    const parametrosConsulta = [];
    
    if (pacienteId) {
      textoConsulta += ' WHERE pm.patient_id = $1';
      parametrosConsulta.push(pacienteId);
    }
    
    textoConsulta += ' ORDER BY pm.created_at DESC';
    
    const resultado = await pool.query(textoConsulta, parametrosConsulta);
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar acompanhamentos de gestantes:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Obter acompanhamento de gestante por ID
app.get('/api/gestantes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar dados do acompanhamento
    const resultadoGestante = await pool.query(`
      SELECT pm.*, p.full_name as nome_paciente 
      FROM pregnancy_monitoring pm
      JOIN patients p ON pm.patient_id = p.id
      WHERE pm.id = $1
    `, [id]);
    
    if (resultadoGestante.rows.length === 0) {
      return res.status(404).json({ erro: 'Acompanhamento de gestante não encontrado' });
    }
    
    // Buscar exames relacionados
    const resultadoExames = await pool.query(`
      SELECT pe.*, e.exam_type, e.scheduled_date, e.status
      FROM pregnancy_exams pe
      JOIN exams e ON pe.exam_id = e.id
      WHERE pe.pregnancy_id = $1
    `, [id]);
    
    const gestante = resultadoGestante.rows[0];
    gestante.exames = resultadoExames.rows;
    
    res.json(gestante);
  } catch (erro) {
    console.error('Erro ao buscar acompanhamento de gestante:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Criar novo acompanhamento de gestante
app.post('/api/gestantes', async (req, res) => {
  const cliente = await pool.connect();
  
  try {
    await cliente.query('BEGIN');
    
    const {
      paciente_id,
      data_ultima_menstruacao,
      data_prevista_parto,
      numero_gestacao,
      classificacao_risco,
      data_primeira_consulta,
      possui_cartao_gestante
    } = req.body;
    
    const agora = new Date();
    
    // Inserir acompanhamento
    const resultadoGestante = await cliente.query(
      `INSERT INTO pregnancy_monitoring (
        patient_id, last_period_date, expected_birth_date, pregnancy_number,
        risk_classification, first_appointment_date, has_pregnancy_card, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
      RETURNING *`,
      [
        paciente_id, data_ultima_menstruacao, data_prevista_parto, numero_gestacao,
        classificacao_risco, data_primeira_consulta, possui_cartao_gestante || false, agora, agora
      ]
    );
    
    // Atualizar status da paciente
    await cliente.query(
      `UPDATE patients SET 
        is_pregnant = true, 
        updated_at = $1
      WHERE id = $2`,
      [agora, paciente_id]
    );
    
    await cliente.query('COMMIT');
    
    res.status(201).json(resultadoGestante.rows[0]);
  } catch (erro) {
    await cliente.query('ROLLBACK');
    console.error('Erro ao criar acompanhamento de gestante:', erro);
    res.status(500).json({ erro: erro.message });
  } finally {
    cliente.release();
  }
});

// Atualizar acompanhamento de gestante
app.put('/api/gestantes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      data_ultima_menstruacao,
      data_prevista_parto,
      numero_gestacao,
      classificacao_risco,
      data_primeira_consulta,
      possui_cartao_gestante
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `UPDATE pregnancy_monitoring SET 
        last_period_date = $1, 
        expected_birth_date = $2, 
        pregnancy_number = $3, 
        risk_classification = $4, 
        first_appointment_date = $5, 
        has_pregnancy_card = $6, 
        updated_at = $7
      WHERE id = $8 
      RETURNING *`,
      [
        data_ultima_menstruacao, data_prevista_parto, numero_gestacao,
        classificacao_risco, data_primeira_consulta, possui_cartao_gestante, agora, id
      ]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Acompanhamento de gestante não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao atualizar acompanhamento de gestante:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Adicionar exame ao acompanhamento de gestante
app.post('/api/gestantes/:id/exames', async (req, res) => {
  try {
    const { id } = req.params;
    const { exame_id, concluido } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `INSERT INTO pregnancy_exams (
        pregnancy_id, exam_id, is_completed, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5) 
      RETURNING *`,
      [id, exame_id, concluido || false, agora, agora]
    );
    
    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao adicionar exame ao acompanhamento de gestante:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Atualizar status de exame no acompanhamento de gestante
app.put('/api/gestantes/exames/:exameId', async (req, res) => {
  try {
    const { exameId } = req.params;
    const { concluido } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `UPDATE pregnancy_exams SET 
        is_completed = $1, 
        updated_at = $2
      WHERE id = $3 
      RETURNING *`,
      [concluido, agora, exameId]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Exame de acompanhamento não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao atualizar exame de acompanhamento:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// ===== CONDIÇÕES CRÔNICAS (HIPERTENSÃO E DIABETES) =====

// Listar acompanhamentos de condições crônicas
app.get('/api/cronicos', async (req, res) => {
  try {
    const { pacienteId, tipoCondicao } = req.query;
    
    let textoConsulta = `
      SELECT cm.*, p.full_name as nome_paciente 
      FROM chronic_monitoring cm
      JOIN patients p ON cm.patient_id = p.id
    `;
    
    const parametrosConsulta = [];
    const condicoes = [];
    
    if (pacienteId) {
      condicoes.push(`cm.patient_id = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(pacienteId);
    }
    
    if (tipoCondicao) {
      condicoes.push(`cm.condition_type = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(tipoCondicao);
    }
    
    if (condicoes.length > 0) {
      textoConsulta += ' WHERE ' + condicoes.join(' AND ');
    }
    
    textoConsulta += ' ORDER BY cm.created_at DESC';
    
    const resultado = await pool.query(textoConsulta, parametrosConsulta);
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar acompanhamentos de condições crônicas:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Obter acompanhamento de condição crônica por ID
app.get('/api/cronicos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const resultado = await pool.query(`
      SELECT cm.*, p.full_name as nome_paciente 
      FROM chronic_monitoring cm
      JOIN patients p ON cm.patient_id = p.id
      WHERE cm.id = $1
    `, [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Acompanhamento de condição crônica não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao buscar acompanhamento de condição crônica:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Criar novo acompanhamento de condição crônica
app.post('/api/cronicos', async (req, res) => {
  const cliente = await pool.connect();
  
  try {
    await cliente.query('BEGIN');
    
    const {
      paciente_id,
      tipo_condicao,
      medicamentos,
      adesao_tratamento
    } = req.body;
    
    const agora = new Date();
    
    // Inserir acompanhamento
    const resultadoCronico = await cliente.query(
      `INSERT INTO chronic_monitoring (
        patient_id, condition_type, medications, treatment_adherence, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *`,
      [paciente_id, tipo_condicao, medicamentos, adesao_tratamento, agora, agora]
    );
    
    // Atualizar status do paciente
    const camposAtualizacao = {};
    
    if (tipo_condicao === 'hypertension') {
      camposAtualizacao.is_hypertensive = true;
    } else if (tipo_condicao === 'diabetes') {
      camposAtualizacao.is_diabetic = true;
    }
    
    await cliente.query(
      `UPDATE patients SET 
        ${tipo_condicao === 'hypertension' ? 'is_hypertensive = true' : 'is_diabetic = true'}, 
        updated_at = $1
      WHERE id = $2`,
      [agora, paciente_id]
    );
    
    await cliente.query('COMMIT');
    
    res.status(201).json(resultadoCronico.rows[0]);
  } catch (erro) {
    await cliente.query('ROLLBACK');
    console.error('Erro ao criar acompanhamento de condição crônica:', erro);
    res.status(500).json({ erro: erro.message });
  } finally {
    cliente.release();
  }
});

// Atualizar acompanhamento de condição crônica
app.put('/api/cronicos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      medicamentos,
      adesao_tratamento
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `UPDATE chronic_monitoring SET 
        medications = $1, 
        treatment_adherence = $2, 
        updated_at = $3
      WHERE id = $4 
      RETURNING *`,
      [medicamentos, adesao_tratamento, agora, id]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Acompanhamento de condição crônica não encontrado' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao atualizar acompanhamento de condição crônica:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Registrar medição de pressão arterial
app.post('/api/cronicos/:id/pressao-arterial', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      data_medicao,
      sistolica,
      diastolica,
      observacoes
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `INSERT INTO blood_pressure_records (
        chronic_monitoring_id, measurement_date, systolic, diastolic, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *`,
      [id, data_medicao, sistolica, diastolica, observacoes, agora]
    );
    
    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao registrar medição de pressão arterial:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Listar medições de pressão arterial
app.get('/api/cronicos/:id/pressao-arterial', async (req, res) => {
  try {
    const { id } = req.params;
    
    const resultado = await pool.query(
      `SELECT * FROM blood_pressure_records 
      WHERE chronic_monitoring_id = $1 
      ORDER BY measurement_date DESC`,
      [id]
    );
    
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar medições de pressão arterial:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Registrar medição de glicemia
app.post('/api/cronicos/:id/glicemia', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      data_medicao,
      nivel_glicemia,
      tipo_medicao,
      observacoes
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `INSERT INTO glucose_records (
        chronic_monitoring_id, measurement_date, glucose_level, measurement_type, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *`,
      [id, data_medicao, nivel_glicemia, tipo_medicao, observacoes, agora]
    );
    
    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao registrar medição de glicemia:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Listar medições de glicemia
app.get('/api/cronicos/:id/glicemia', async (req, res) => {
  try {
    const { id } = req.params;
    
    const resultado = await pool.query(
      `SELECT * FROM glucose_records 
      WHERE chronic_monitoring_id = $1 
      ORDER BY measurement_date DESC`,
      [id]
    );
    
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar medições de glicemia:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// ===== CONSULTAS =====

// Listar consultas
app.get('/api/consultas', async (req, res) => {
  try {
    const { pacienteId, status } = req.query;
    
    let textoConsulta = `
      SELECT a.*, p.full_name as nome_paciente 
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
    `;
    
    const parametrosConsulta = [];
    const condicoes = [];
    
    if (pacienteId) {
      condicoes.push(`a.patient_id = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(pacienteId);
    }
    
    if (status) {
      condicoes.push(`a.status = $${parametrosConsulta.length + 1}`);
      parametrosConsulta.push(status);
    }
    
    if (condicoes.length > 0) {
      textoConsulta += ' WHERE ' + condicoes.join(' AND ');
    }
    
    textoConsulta += ' ORDER BY a.appointment_date DESC';
    
    const resultado = await pool.query(textoConsulta, parametrosConsulta);
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar consultas:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Obter consulta por ID
app.get('/api/consultas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const resultado = await pool.query(`
      SELECT a.*, p.full_name as nome_paciente 
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      WHERE a.id = $1
    `, [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Consulta não encontrada' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao buscar consulta:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Criar nova consulta
app.post('/api/consultas', async (req, res) => {
  try {
    const {
      paciente_id,
      data_consulta,
      tipo_consulta,
      profissional,
      observacoes,
      status
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `INSERT INTO appointments (
        patient_id, appointment_date, appointment_type, professional, notes, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *`,
      [paciente_id, data_consulta, tipo_consulta, profissional, observacoes, status, agora, agora]
    );
    
    res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao criar consulta:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Atualizar consulta
app.put('/api/consultas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      paciente_id,
      data_consulta,
      tipo_consulta,
      profissional,
      observacoes,
      status
    } = req.body;
    
    const agora = new Date();
    
    const resultado = await pool.query(
      `UPDATE appointments SET 
        patient_id = $1, 
        appointment_date = $2, 
        appointment_type = $3, 
        professional = $4, 
        notes = $5, 
        status = $6, 
        updated_at = $7
      WHERE id = $8 
      RETURNING *`,
      [paciente_id, data_consulta, tipo_consulta, profissional, observacoes, status, agora, id]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Consulta não encontrada' });
    }
    
    res.json(resultado.rows[0]);
  } catch (erro) {
    console.error('Erro ao atualizar consulta:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Excluir consulta
app.delete('/api/consultas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query('DELETE FROM appointments WHERE id = $1 RETURNING *', [id]);
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Consulta não encontrada' });
    }
    
    res.json({ sucesso: true, mensagem: 'Consulta excluída com sucesso' });
  } catch (erro) {
    console.error('Erro ao excluir consulta:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// ===== RELATÓRIOS =====

// Obter relatório resumido
app.get('/api/relatorios/resumo', async (req, res) => {
  try {
    // Executar consultas em paralelo
    const [
      resultadoPacientes,
      resultadoGestantes,
      resultadoHipertensos,
      resultadoDiabeticos,
      resultadoExamesPendentes
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients'),
      pool.query('SELECT COUNT(*) FROM patients WHERE is_pregnant = true'),
      pool.query('SELECT COUNT(*) FROM patients WHERE is_hypertensive = true'),
      pool.query('SELECT COUNT(*) FROM patients WHERE is_diabetic = true'),
      pool.query("SELECT COUNT(*) FROM exams WHERE status IN ('Agendado', 'Marcado', 'Marcado - Aguardando protocolo')")
    ]);
    
    res.json({
      total_pacientes: parseInt(resultadoPacientes.rows[0].count),
      pacientes_gestantes: parseInt(resultadoGestantes.rows[0].count),
      pacientes_hipertensos: parseInt(resultadoHipertensos.rows[0].count),
      pacientes_diabeticos: parseInt(resultadoDiabeticos.rows[0].count),
      exames_pendentes: parseInt(resultadoExamesPendentes.rows[0].count)
    });
  } catch (erro) {
    console.error('Erro ao gerar relatório resumido:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Obter alertas
app.get('/api/relatorios/alertas', async (req, res) => {
  try {
    // Executar consultas em paralelo
    const [
      resultadoGestantesAltoRisco,
      resultadoPressaoAlta,
      resultadoGlicemiaAlta
    ] = await Promise.all([
      // Gestantes de alto risco
      pool.query(`
        SELECT pm.id, pm.patient_id, p.full_name as nome_paciente 
        FROM pregnancy_monitoring pm
        JOIN patients p ON pm.patient_id = p.id
        WHERE pm.risk_classification = 'alto'
        LIMIT 10
      `),
      
      // Pacientes com pressão alta na última medição
      pool.query(`
        WITH registros_classificados AS (
          SELECT 
            bp.*,
            cm.patient_id,
            p.full_name as nome_paciente,
            ROW_NUMBER() OVER (PARTITION BY cm.patient_id ORDER BY bp.measurement_date DESC) as rn
          FROM blood_pressure_records bp
          JOIN chronic_monitoring cm ON bp.chronic_monitoring_id = cm.id
          JOIN patients p ON cm.patient_id = p.id
          WHERE bp.systolic > 140 OR bp.diastolic > 90
        )
        SELECT * FROM registros_classificados WHERE rn = 1 LIMIT 10
      `),
      
      // Pacientes com glicemia alta na última medição
      pool.query(`
        WITH registros_classificados AS (
          SELECT 
            gr.*,
            cm.patient_id,
            p.full_name as nome_paciente,
            ROW_NUMBER() OVER (PARTITION BY cm.patient_id ORDER BY gr.measurement_date DESC) as rn
          FROM glucose_records gr
          JOIN chronic_monitoring cm ON gr.chronic_monitoring_id = cm.id
          JOIN patients p ON cm.patient_id = p.id
          WHERE gr.glucose_level > 180
        )
        SELECT * FROM registros_classificados WHERE rn = 1 LIMIT 10
      `)
    ]);
    
    res.json({
      gestantes_alto_risco: resultadoGestantesAltoRisco.rows,
      pressao_alta: resultadoPressaoAlta.rows,
      glicemia_alta: resultadoGlicemiaAlta.rows
    });
  } catch (erro) {
    console.error('Erro ao gerar relatório de alertas:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Iniciar o servidor
app.listen(porta, () => {
  console.log(`Servidor rodando na porta ${porta}`);
});




module.exports = app;
>>>>>>> f24d6995816ac4a8a9124ddadcb48219f23e467f
