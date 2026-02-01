# Guide du Débutant

Bienvenue dans ce guide d'introduction au développement d'applications.

## Installation

### Prérequis

- Node.js 20 ou supérieur
- pnpm (gestionnaire de paquets recommandé)
- Git

### Démarrage rapide

```bash
# Cloner le dépôt
git clone https://github.com/example/app.git
cd app

# Installer les dépendances
pnpm install

# Configurer l'environnement
cp .env.example .env

# Démarrer en mode développement
pnpm dev
```

L'application sera accessible sur `http://localhost:3000`.

## Structure du Projet

```
src/
├── components/   # Composants React réutilisables
├── pages/        # Routes de l'application
├── hooks/        # Hooks personnalisés
├── utils/        # Fonctions utilitaires
├── services/     # Appels API
└── types/        # Définitions TypeScript
```

## Concepts Fondamentaux

### Composants

Les composants sont les blocs de construction de l'interface utilisateur:

```tsx
interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

export function Button({ label, onClick, variant = "primary" }: ButtonProps) {
  return (
    <button className={`btn btn-${variant}`} onClick={onClick}>
      {label}
    </button>
  );
}
```

### Hooks

Les hooks permettent d'ajouter des fonctionnalités aux composants:

```typescript
function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    fetch(url)
      .then((res) => res.json())
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [url]);

  return { data, loading, error };
}
```

### Gestion d'État

Pour la gestion d'état globale, utilisez Zustand:

```typescript
import { create } from "zustand";

interface UserStore {
  user: User | null;
  login: (credentials: Credentials) => Promise<void>;
  logout: () => void;
}

const useUserStore = create<UserStore>((set) => ({
  user: null,
  login: async (credentials) => {
    const user = await authService.login(credentials);
    set({ user });
  },
  logout: () => set({ user: null }),
}));
```

## Tests

### Tests Unitaires

```typescript
import { test, expect } from "bun:test";
import { formatDate } from "./utils";

test("formatDate retourne une date formatée", () => {
  const result = formatDate(new Date("2024-01-15"));
  expect(result).toBe("15 janvier 2024");
});
```

### Tests d'Intégration

```typescript
test("création de compte utilisateur", async () => {
  const response = await fetch("/api/users", {
    method: "POST",
    body: JSON.stringify({
      email: "test@example.com",
      password: "motdepasse123",
    }),
  });

  expect(response.status).toBe(201);
  const user = await response.json();
  expect(user.email).toBe("test@example.com");
});
```

## Ressources Supplémentaires

- [Documentation officielle](https://docs.example.com)
- [Forum communautaire](https://forum.example.com)
- [Exemples de code](https://github.com/example/samples)
