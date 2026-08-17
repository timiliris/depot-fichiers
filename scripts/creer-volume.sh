#!/bin/bash
# Crée un volume de taille fixe pour le dépôt, monté par /etc/fstab.
#
# La taille bornée est le point important : un envoi massif ne peut pas remplir
# le disque de la machine, et donc pas mettre à genoux ce qui tourne à côté.
#
#   ./creer-volume.sh /srv/depot.img /srv/depot 100G
set -euo pipefail

IMG="${1:?chemin de l image, ex: /srv/depot.img}"
MNT="${2:?point de montage, ex: /srv/depot}"
SIZE="${3:-100G}"

[ "$(id -u)" -eq 0 ] || { echo "à lancer en root" >&2; exit 1; }

if [ ! -f "$IMG" ]; then
  fallocate -l "$SIZE" "$IMG"
  mkfs.ext4 -q -m 0 -L depot "$IMG"
  echo "image créée : $IMG ($SIZE)"
fi

mkdir -p "$MNT"
if ! grep -q " $MNT " /etc/fstab; then
  echo "$IMG $MNT ext4 loop,defaults,nosuid,nodev,noexec 0 2" >> /etc/fstab
  echo "entrée ajoutée à /etc/fstab"
fi
mountpoint -q "$MNT" || mount "$MNT"
df -h "$MNT"

cat <<'NOTE'

Pour agrandir plus tard (service arrêté, volume démonté) :
  truncate -s 200G <image>
  e2fsck -f <image> && resize2fs <image>
NOTE
