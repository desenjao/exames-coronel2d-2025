import bcrypt from 'bcrypt';

const gerarHashSenha = async (senha) => {
    const salt = await bcrypt.genSalt(10); // Salting
    const hash = await bcrypt.hash(senha, salt); // Gerando o hash
    console.log(hash);
};

// Exemplo de uso:
gerarHashSenha('123');
