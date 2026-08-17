# Accès SFTP

Le SFTP et la page web servent **le même dossier**. Un fichier déposé par l'un
est immédiatement visible par l'autre, avec son vrai nom.

Le SFTP reste utile même avec une interface web : c'est la voie qui n'a aucune
limite de taille de requête, qui supporte le mieux une ligne capricieuse, et qui
permet un `rsync` depuis la machine qui héberge.

## Pourquoi une seconde instance sshd

Le sshd du port 22 sert aussi l'administration de la machine. Ajouter des comptes
de dépôt à sa configuration obligerait à exposer ce port pour donner un accès
SFTP — donc à mettre la connexion root sur le chemin des balayages automatiques.
Une instance séparée, avec sa configuration et son port, garde les deux mondes
distincts. Le sshd du système n'est pas modifié d'une ligne.

## Mise en place

```bash
# 1. Groupe et compte, sans shell
groupadd sftpusers
useradd -M -d /upload -s /usr/sbin/nologin -g sftpusers invite

# 2. Arborescence de la prison : la racine DOIT être root:root et non inscriptible,
#    sinon sshd refuse le chroot
install -d -o root -g root -m 755 /srv/depot/invite
install -d -o invite -g sftpusers -m 775 /srv/depot/invite/upload

# 3. Configuration et service
cp sftp/sshd_sftp_config.example /etc/ssh/sshd_sftp_config
chmod 600 /etc/ssh/sshd_sftp_config
sshd -t -f /etc/ssh/sshd_sftp_config          # à vérifier AVANT de démarrer
cp sftp/sshd-sftp.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sshd-sftp.service
```

`ChrootDirectory` place l'utilisateur dans `/srv/depot/<compte>`, et son dossier
d'accueil `/upload` est le seul endroit où il peut écrire. Le dossier servi par la
page web doit être ce même `/srv/depot/<compte>/upload`.

## Pièges

- **La racine du chroot doit appartenir à root et n'être inscriptible que par
  lui.** C'est une exigence d'OpenSSH ; sinon la connexion échoue sans message
  clair côté client.
- **Vérifier la configuration avec `sshd -t` avant de démarrer**, et garder une
  session ouverte le temps de valider.
- Le conteneur du service web doit tourner avec l'`uid` du compte SFTP, sinon les
  fichiers déposés par une voie ne sont pas gérables par l'autre.
