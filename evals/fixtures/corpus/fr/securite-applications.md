# Sécurité des Applications Web

Guide complet sur la sécurisation des applications web modernes.

## Authentification

### Tokens JWT

Les JSON Web Tokens offrent une authentification sans état:

```typescript
import jwt from "jsonwebtoken";

function genererToken(utilisateur: Utilisateur): string {
  return jwt.sign(
    {
      id: utilisateur.id,
      email: utilisateur.email,
      role: utilisateur.role,
    },
    process.env.JWT_SECRET!,
    { expiresIn: "24h" }
  );
}

function verifierToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
  } catch (err) {
    throw new AuthenticationError("Token invalide ou expiré");
  }
}
```

### Hachage des Mots de Passe

Utilisez toujours un algorithme de hachage sécurisé:

```typescript
import { hash, verify } from "argon2";

async function hacherMotDePasse(motDePasse: string): Promise<string> {
  return hash(motDePasse, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
}

async function verifierMotDePasse(
  motDePasse: string,
  hache: string
): Promise<boolean> {
  return verify(hache, motDePasse);
}
```

## Protection Contre les Attaques

### Injection SQL

Utilisez toujours des requêtes paramétrées:

```typescript
// DANGEREUX - Ne jamais faire cela
const query = `SELECT * FROM users WHERE id = ${userId}`;

// SÉCURISÉ - Requête paramétrée
const query = "SELECT * FROM users WHERE id = $1";
const result = await db.query(query, [userId]);
```

### Cross-Site Scripting (XSS)

Échappez toujours les données utilisateur:

```typescript
import { escapeHtml } from "./sanitize";

function afficherCommentaire(commentaire: string): string {
  // Échapper le HTML pour prévenir XSS
  return `<div class="comment">${escapeHtml(commentaire)}</div>`;
}
```

### CSRF (Cross-Site Request Forgery)

Implémentez des tokens CSRF pour les formulaires:

```typescript
import { generateToken, validateToken } from "./csrf";

// Génération
app.get("/form", (req, res) => {
  const csrfToken = generateToken(req.session.id);
  res.render("form", { csrfToken });
});

// Validation
app.post("/submit", (req, res) => {
  if (!validateToken(req.body.csrfToken, req.session.id)) {
    return res.status(403).json({ error: "Token CSRF invalide" });
  }
  // Traiter le formulaire
});
```

## En-têtes de Sécurité

Configurez les en-têtes HTTP de sécurité:

```typescript
import helmet from "helmet";

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
  })
);
```

## Gestion des Secrets

### Variables d'Environnement

Ne jamais stocker de secrets dans le code:

```typescript
// Configuration sécurisée
const config = {
  database: {
    url: process.env.DATABASE_URL,
    password: process.env.DB_PASSWORD,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: "24h",
  },
};

// Vérification au démarrage
for (const [key, value] of Object.entries(process.env)) {
  if (key.includes("SECRET") && !value) {
    throw new Error(`Variable ${key} non définie`);
  }
}
```

## Audit et Journalisation

Enregistrez les événements de sécurité:

```typescript
const auditLogger = pino({
  name: "security-audit",
  level: "info",
});

function logEvenementSecurite(evenement: EvenementSecurite) {
  auditLogger.info({
    type: evenement.type,
    utilisateur: evenement.utilisateurId,
    ip: evenement.adresseIP,
    timestamp: new Date().toISOString(),
    details: evenement.details,
  });
}

// Utilisation
logEvenementSecurite({
  type: "LOGIN_ECHEC",
  utilisateurId: email,
  adresseIP: req.ip,
  details: { raison: "Mot de passe incorrect" },
});
```
