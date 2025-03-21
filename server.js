import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs/promises'; // Usar versão assíncrona do fs
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(cors({
    origin: 'http://localhost:5173', // Permite apenas requisições do frontend
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeçalhos permitidos
}));
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'chave_secreta';

app.use(express.json());
app.use(morgan('dev'));

const DATA_FILE = 'data/exames.json';
const USERS_FILE = 'data/users.json';

// Função para ler os dados do arquivo JSON
const readData = async (file) => {
    try {
        const data = await fs.readFile(file, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Erro ao ler arquivo:', err);
        return [];
    }
};

// Função para salvar os dados no arquivo JSON
const saveData = async (file, data) => {
    try {
        await fs.writeFile(file, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Erro ao salvar dados:', err);
    }
};

// Middleware para verificar token JWT
const authenticateToken = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ message: 'Acesso negado' });

    jwt.verify(token.replace('Bearer ', ''), SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token inválido' });
        req.user = user;
        next();
    });
};
app.get('/', async (req, res) => {
    console.log("Server rodando");
    res.status(200).json({ message: 'Servidor rodando com sucesso!' });
});

// Rota de login (sem criptografia de senha)
app.post('/login', async (req, res) => {
    const { login, password } = req.body;

    // Exibe a senha recebida no console (apenas para depuração)
    console.log('Senha recebida:', password);

    try {
        const users = await readData(USERS_FILE);
        const user = users.find(u => u.login === login);

        // Verificando a senha diretamente (sem bcrypt, apenas para fins de teste)
        if (!user || user.password !== password) {
            return res.status(401).json({ message: 'Usuário ou senha incorretos' });
        }

        const token = jwt.sign({ id: user.id, login: user.login }, SECRET_KEY, { expiresIn: '2h' });
        res.json({ token });
    } catch (err) {
        res.status(500).json({ message: 'Erro no servidor', error: err.message });
    }
});
// Rota para listar todos os exames (apenas usuários autenticados)
app.get('/exames', authenticateToken, async (req, res) => {
    try {
        const exames = await readData(DATA_FILE);
        res.json(exames);
    } catch (err) {
        res.status(500).json({ message: 'Erro ao ler os exames', error: err.message });
    }
});

// Rota para adicionar um novo exame
app.post('/exames', authenticateToken, async (req, res) => {
    try {
        const exames = await readData(DATA_FILE);
        const novoExame = { id: Date.now(), ...req.body };
        exames.push(novoExame);
        await saveData(DATA_FILE, exames);
        res.status(201).json(novoExame);
    } catch (err) {
        res.status(500).json({ message: 'Erro ao adicionar exame', error: err.message });
    }
});

// Rota para atualizar um exame existente
app.put('/exames/:id', authenticateToken, async (req, res) => {
    try {
        let exames = await readData(DATA_FILE);
        const index = exames.findIndex(e => e.id == req.params.id);
        if (index === -1) return res.status(404).json({ message: 'Exame não encontrado' });
        
        exames[index] = { ...exames[index], ...req.body };
        await saveData(DATA_FILE, exames);
        res.json(exames[index]);
    } catch (err) {
        res.status(500).json({ message: 'Erro ao atualizar exame', error: err.message });
    }
});

// Rota para excluir um exame
app.delete('/exames/:id', authenticateToken, async (req, res) => {
    try {
        let exames = await readData(DATA_FILE);
        exames = exames.filter(e => e.id != req.params.id);
        await saveData(DATA_FILE, exames);
        res.json({ message: 'Exame removido com sucesso' });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao excluir exame', error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
