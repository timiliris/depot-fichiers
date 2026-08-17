# Dépôt

Un espace de dépôt de fichiers auto-hébergé : une page web pour envoyer des
fichiers volumineux depuis un navigateur, et un accès SFTP sur **le même
dossier**. Pensé pour donner à quelqu'un un endroit où déposer des vidéos sans
lui faire installer quoi que ce soit, et sans confier ses fichiers à un service
tiers.

Le stockage est assuré par [dufs](https://github.com/sigoden/dufs). Ce dépôt
apporte les deux morceaux qui manquaient : une authentification par session avec
une vraie page de connexion, et un envoi découpé en tranches capable de traverser
un proxy qui plafonne la taille des requêtes.

![Liste des fichiers](docs/liste.png)

<table>
  <tr>
    <td width="66%"><img src="docs/connexion.png" alt="Page de connexion"></td>
    <td><img src="docs/mobile.png" alt="Affichage sur téléphone"></td>
  </tr>
</table>

Les captures sont produites par [`docs/captures.py`](docs/captures.py), qui sert
les vrais fichiers d'interface avec des données de démonstration — donc elles se
régénèrent après une modification du style, et ne montrent jamais le contenu
d'une installation réelle.

## Pourquoi ce n'est pas juste « dufs derrière un proxy »

Deux contraintes ont dicté l'architecture. Chacune se paie si on l'ignore.

**dufs ne sait faire que du HTTP Basic.** Le navigateur affiche alors sa propre
fenêtre d'identifiants, qu'aucune feuille de style ne peut remplacer. Mettre une
page de connexion devant suppose donc que le navigateur ne parle jamais
directement à dufs. C'est le rôle de `depot-gw` : il possède la session, sert
l'interface, et relaie les appels de stockage. Le cookie qu'il pose vaut aussi
pour les téléchargements et la lecture vidéo — ce qu'un en-tête `Authorization`
ne peut pas faire depuis un simple `<a download>` ou `<video src>`.

**Cloudflare refuse tout corps de requête au-delà de 100 Mo** (offres Free et
Pro ; 200 Mo en Business, 500 Mo en Enterprise). Un tunnel ou un enregistrement
proxifié n'y échappe pas. Envoyer un fichier entier en une requête condamne donc
toute vidéo un peu sérieuse à un `413`. L'interface découpe en tranches de 32 Mo :
la première en `PUT`, les suivantes en `PATCH` avec l'en-tête
`X-Update-Range: append` que dufs sait recoller. Effet de bord bienvenu, une
coupure ne coûte que la tranche en cours, et la pause devient gratuite.

## Architecture

```mermaid
flowchart LR
    N["Navigateur"] -->|"HTTPS + cookie"| P["Proxy inverse<br/>(TLS, nom public)"]
    P -->|HTTP| G["depot-gw<br/>session, interface, relais"]
    G -->|"réseau interne"| D["dufs<br/>stockage"]
    S["Client SFTP"] -->|"SSH port dédié"| H["sshd dédié<br/>SFTP seul, chroot"]
    D --> V[("Volume à taille fixe")]
    H --> V
```

Seul `depot-gw` est publié. dufs n'écoute que sur le réseau interne du stack, et
l'instance sshd est séparée de celle du système pour ne jamais exposer la
connexion root du port 22.

## Fonctions

- Page de connexion, session par cookie signé, déconnexion
- Glisser-déposer sur toute la page, y compris des **dossiers entiers**
- Envoi par tranches, **reprise après coupure**, pause, annulation, relance
- Progression par fichier : pourcentage, débit, temps restant
- Liste ou grille, fil d'Ariane, filtre, tri par colonnes
- Aperçu en place : vidéo, image, audio, texte, PDF
- Nouveau dossier, renommage, suppression — avec des dialogues maison, aucune
  fenêtre du navigateur
- Indicateur de remplissage du volume
- Thème sombre et clair selon le système, utilisable au doigt sur téléphone

## Mise en place

### 1. Un volume à taille fixe

Pour qu'un dépôt massif ne puisse pas remplir le disque de la machine, le dossier
servi vit dans une image de taille bornée :

```bash
sudo ./scripts/creer-volume.sh /srv/depot.img /srv/depot 100G
```

### 2. Le compte et l'instance SFTP

Voir [`sftp/README.md`](sftp/README.md). Le point à ne pas manquer : c'est une
**seconde** instance sshd, avec sa propre configuration, sur son propre port.
Ajouter des comptes SFTP au sshd du port 22 obligerait à exposer publiquement le
port qui sert aussi la connexion root.

### 3. Les deux fichiers de configuration

Il en faut **deux**, un par étage. Ils sont dans `.gitignore` : à créer depuis les
gabarits.

```bash
cp dufs.example.yaml       config.yaml          # le stockage
cp gateway/config.example.json gateway/config.json   # la passerelle
```

Oublier `config.yaml` est l'erreur la plus facile : Docker crée alors un *dossier*
de ce nom et le stockage refuse de démarrer sur `Is a directory (os error 21)`.

### 4. Le chemin des données et l'identité

Le service écrit dans le dossier partagé avec le SFTP, et doit le faire sous le
même compte, sinon les fichiers déposés par une voie ne sont pas gérables par
l'autre. Ça se règle dans un `.env` à côté du `docker-compose.yml` :

```ini
DEPOT_DATA=/srv/depot/invite/upload   # le dossier servi, celui du chroot SFTP
DEPOT_UID=1001                        # id du compte SFTP: id -u invite
DEPOT_GID=1001                        # id -g invite
DEPOT_BIND=127.0.0.1                  # adresse de publication, laissée au proxy
```

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DEPOT_DATA` | `/srv/depot/upload` | dossier servi, partagé avec le SFTP |
| `DEPOT_UID` / `DEPOT_GID` | `1001` | compte sous lequel les fichiers sont écrits |
| `DEPOT_BIND` | `127.0.0.1` | adresse d'écoute publiée, port 8099 |

### 5. Les comptes

```bash
docker compose build
docker run --rm depot-gw:1 -hash 'le-mot-de-passe'
```

Reporter l'empreinte obtenue dans `gateway/config.json`, et **remplacer le
`secret`** par une valeur aléatoire :

```bash
openssl rand -base64 48
```

Le secret du gabarit est publié ici : le laisser en place permettrait à n'importe
qui de forger un cookie de session valide. Le service refuse de démarrer tant
qu'il n'est pas changé.

```bash
docker compose up -d
```

Vérifier que les deux étages tiennent :

```bash
docker compose ps
docker compose logs depot-stockage    # doit annoncer son écoute, pas une erreur
curl -si localhost:8099/ | head -1    # 200, et aucun en-tête WWW-Authenticate
```

### 6. Derrière un proxy inverse

Deux réglages ne sont pas optionnels si des fichiers volumineux doivent passer :

```nginx
client_max_body_size 0;        # sinon la limite du proxy tronque les tranches
proxy_request_buffering off;   # sinon le proxy recopie tout sur son disque avant de relayer
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

`proxy_request_buffering off` est le plus facile à oublier et le plus coûteux :
sans lui, un envoi de 20 Go est d'abord écrit en entier sur le disque de la
machine qui héberge le proxy.

## Mettre à jour

```bash
git pull
docker compose build
docker compose up -d
```

L'image dufs est épinglée dans le `docker-compose.yml`. Elle peut être montée de
version librement : l'interface est servie par la passerelle, pas par dufs, donc
rien à reporter côté stockage.

## Configuration

| Clé | Rôle |
| --- | --- |
| `listen` | adresse d'écoute interne (`:5100`) |
| `upstream` | URL de dufs (`http://depot-stockage:5000`) |
| `upstream_auth` | `utilisateur:motdepasse` si dufs garde ses comptes, sinon vide |
| `quota_path` | chemin dont on lit le remplissage |
| `session_ttl_hours` | durée de vie du cookie |
| `secret` | clé de signature du cookie, 32 caractères minimum |
| `title` | nom affiché |
| `users[]` | `name`, `hash` (PBKDF2), `admin` |

`gateway/config.json` contient une clé de signature et des empreintes de mots de
passe : il est dans `.gitignore` et n'a rien à faire dans un dépôt Git.

## Sécurité

- Mots de passe en PBKDF2-HMAC-SHA256, 210 000 itérations, sel par compte
- Cookie de session signé en HMAC-SHA256, `HttpOnly`, `SameSite=Lax`, `Secure`
  dès que la requête arrive en HTTPS
- Temps de réponse constant entre compte inconnu et mot de passe faux
- Blocage progressif par IP après 5 échecs : 1, 2, 4… jusqu'à 32 minutes
- Toute écriture exige un en-tête `X-Depot`, qu'un formulaire d'un autre site ne
  peut pas poser
- Les chemins sont normalisés avant d'atteindre le stockage
- Aucune dépendance externe côté serveur comme côté navigateur : pas de CDN, pas
  de module tiers, donc rien à surveiller au-delà de la bibliothèque standard

## Crédits

Le stockage est [dufs](https://github.com/sigoden/dufs) de sigoden, sous licence
MIT ou Apache-2.0. Son API `PATCH` + `X-Update-Range: append` est ce qui rend
l'envoi par tranches possible sans rien modifier chez lui.

Ce dépôt est sous [licence MIT](LICENSE).
