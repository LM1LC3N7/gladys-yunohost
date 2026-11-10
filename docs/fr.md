# YunoHost

Un serveur **YunoHost** (version 11.1 ou plus récente) dans Gladys, par l’API
de son administration web. Pratique pour savoir d’un coup d’œil, ou dans une
scène, que des mises à jour attendent, qu’un service s’est arrêté, que le
diagnostic a trouvé un problème ou que la dernière sauvegarde vieillit :

- le serveur devient un appareil Gladys (onglet Découverte) : **version de
  YunoHost** (YunoHost version), **paquets système à mettre à jour**,
  **applications à mettre à jour**, **mise à jour majeure de YunoHost
  disponible** (oui / non), **migrations en attente**, **âge des listes de
  paquets** (heures depuis que YunoHost a récupéré les listes de paquets),
  **services arrêtés**, **erreurs** et **avertissements du diagnostic**,
  **sauvegardes locales** et **âge de la plus récente** (heures), **dernière
  action** (Last action, le résultat du dernier bouton pressé) ; et pour chaque
  service que YunoHost liste : **en marche** (oui / non) ;
- des boutons pour **mettre à jour le système**, **mettre à jour les
  applications**, **sauvegarder le serveur** et **redémarrer** un service,
  chacun refusé tant que vous ne l’autorisez pas.

Les noms des fonctions sont en anglais dans Gladys (comme les autres
intégrations) ; ce document les donne en français.

Gladys lit seulement ce que YunoHost garde : il ne rafraîchit jamais les
listes de mises à jour (YunoHost récupère le catalogue d’applications chaque
jour ; les listes de paquets système sont récupérées par YunoHost ou par
Debian, voir « âge des listes de paquets »), et il ne lance jamais le
diagnostic (YunoHost le lance deux fois par jour). Un service compte comme
**arrêté** quand il est activé au démarrage et arrêté ou en échec ; un service
désactivé exprès ne l’est pas ; un service dont YunoHost ne connaît pas l’état
(un service à exécution unique) est inconnu, pas arrêté. Le diagnostic compte
ce que vous n’avez pas ignoré dans l’administration web.

> **Cette intégration n’a jamais été testée avec un vrai serveur YunoHost.**
> Cette première version suit les routes de l’API d’administration de YunoHost
> (son « actionsmap », telle que la documentation développeur la décrit) et n’a
> été testée qu’avec un faux serveur. Dites sur le forum de Gladys ce qui
> marche et ce qui ne marche pas, avec votre version de YunoHost.

Intégration non officielle, sans lien avec le projet YunoHost. YunoHost est un
logiciel libre sous AGPL : cette intégration appelle seulement son API, elle
ne contient rien de son code.

## Avant de commencer

1. Gladys a besoin d’un **administrateur** YunoHost (un membre du groupe
   `admins`, comme le premier utilisateur créé à l’installation). Son mot de
   passe est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
   seulement au serveur.
2. Si la **liste d’autorisation** de l’administration web est active
   (paramètres de YunoHost, sécurité), ajoutez-y l’adresse de Gladys, sinon le
   serveur répond HTTP 403.
3. Ajoutez une intégration par serveur.

## Réglages

- **Adresse du serveur** : son adresse IP locale ou son domaine, telle que vous
  la saisissez pour ouvrir l’administration web. HTTPS seulement (port 443,
  ou `:port`) ; une adresse copiée depuis le navigateur
  (`https://.../yunohost/admin/`) est acceptée.
- **Administrateur**, **Mot de passe**.
- **Empreinte du certificat** (facultatif) : voir plus bas.
- **Rafraîchissement** : 5, 15 (par défaut), 30 ou 60 minutes. Le bouton de
  test, l’enregistrement du formulaire et un redémarrage de Gladys ou du
  conteneur ne lisent pas plus tôt (l’heure de la dernière tentative est
  gardée, écrite avant la lecture). La fin d’une mise à jour ou d’une
  sauvegarde avance une lecture (15 s après).
- **Autoriser les mises à jour depuis Gladys**, **Autoriser les sauvegardes
  depuis Gladys** : désactivés par défaut.
- **Services que Gladys peut redémarrer** : vide par défaut (aucun
  redémarrage). Les noms des services, tels que la page Services de
  l’administration web les liste, séparés par des virgules, 16 au plus ;
  chacun reçoit un bouton **Restart**.

## Le certificat HTTPS

Gladys vérifie le certificat du serveur juste après la négociation TLS et
**avant** d’envoyer le mot de passe :

- un certificat garanti par une **autorité publique**, établi pour l’adresse
  saisie (un domaine avec son certificat Let’s Encrypt) : accepté comme le
  ferait un navigateur, jamais épinglé ; ses renouvellements (tous les deux ou
  trois mois, avec une nouvelle clé) sont acceptés aussi ;
- tout autre certificat (auto-signé, une adresse IP, un nom en `.local`, ou un
  certificat établi pour un autre nom que l’adresse saisie) : vérifié par son
  empreinte SHA-256. Champ vide, à la première connexion : Gladys écrit le
  certificat rencontré dans son stockage, **puis** envoie le mot de passe. Si
  son stockage est illisible, rien n’est appris et rien n’est envoyé (l’état
  donne l’empreinte rencontrée ; le stockage est relu toutes les 10 s) ; s’il
  est non inscriptible, de même, réessayé au démarrage suivant (enregistrement
  du formulaire, reconnexion de Gladys). Ensuite, un autre certificat arrête tout (rien n’est
  envoyé) et l’état donne son empreinte ;
- un serveur dont le certificat était valide et ne l’est plus (expiré, établi
  pour un autre nom, ou sans autorité connue) : tout s’arrête, rien n’est
  envoyé, il n’est jamais appris en silence ; l’état dit lequel des trois ;
- après un arrêt, enregistrer à nouveau le formulaire ne change rien. Vérifiez
  l’empreinte (votre navigateur la montre : cadenas, certificat, SHA-256),
  puis appuyez deux fois en 2 minutes sur **Faire confiance au certificat
  rencontré** (le premier appui montre l’empreinte, le second l’approuve : il
  est épinglé dès lors), ou saisissez-la dans **Empreinte du certificat**. Une
  empreinte saisie dans le formulaire est la seule approuvée tant que vous ne
  la changez pas, même si une autorité en garantit une autre.

## Les actions

Chaque action est un bouton, jamais un interrupteur : un « tout éteindre »
d’un assistant vocal ou d’une scène ne l’atteint jamais. Gladys ne met à jour,
ne sauvegarde ni ne redémarre jamais rien de lui-même.

- **Mettre à jour le système** et **Mettre à jour les applications** lancent ce
  que lancent les boutons de mise à jour de l’administration web. Une mise à
  jour de YunoHost lui-même redémarre son API : les lectures peuvent échouer
  une minute pendant ce temps.
- **Sauvegarder le serveur** fait une sauvegarde locale complète (toutes les
  applications et le système), comme l’administration web par défaut :
  attention à la place libre sur le disque.
- **Redémarrer** (un bouton par service listé) redémarre ce service. Son
  résultat est relu 5 s après : « fait, le service tourne », ou « fait, mais le
  service ne tourne pas », ou « tourne, redémarrage pas encore vu » quand
  YunoHost donne encore l’heure de son démarrage précédent. Redémarrer nginx ou
  yunohost-api depuis Gladys coupe sa propre réponse.

Une mise à jour ou une sauvegarde tourne dans YunoHost, jusqu’à une heure :
l’appui reçoit sa réponse dès que la requête est partie (et que YunoHost ne
l’a pas refusée en quelques secondes) ; le résultat s’affiche dans **Dernière
action** (« terminée », « refusée par YunoHost », « échouée ou refusée »,
« envoyée, sans réponse finale : elle tourne peut-être encore » ; textes en
anglais). Un redémarrage reçoit la réponse de YunoHost : sans réponse dans les
5 s que Gladys accorde à une commande, l’appui dit « envoyé, sans réponse pour
l’instant », jamais un succès.

Un appui est refusé, rien n’est envoyé, dans ces cas :

- l’option de l’action est désactivée, ou le service n’est pas listé (vérifié
  à nouveau juste avant l’écriture de la requête) ;
- la configuration est incomplète, la connexion ou le certificat a été refusé,
  une connexion serait nécessaire pendant l’attente qui suit un refus, ou Gladys est en pause à la demande du
  serveur (HTTP 429 ou 5xx) ;
- la même action a été envoyée il y a peu : 30 minutes pour une mise à jour,
  1 heure pour une sauvegarde, 2 minutes pour le redémarrage d’un service
  (gardé à travers les redémarrages), ou ce délai ne peut pas être écrit dans
  le stockage de l’intégration (/data), ou ce stockage est illisible ;
- une action tourne déjà, ou une lecture en cours ne finit pas dans les 2,5 s
  qui suivent l’appui ;
- le serveur ne répond pas à la lecture faite juste avant dans les 2,5 s (pour
  un redémarrage : YunoHost ne connaît pas le service) ;
- la requête n’a pas pu être écrite dans les 3,5 s qui suivent l’appui.

## Pannes

- **Identifiants refusés** (par la route de connexion de YunoHost seulement,
  HTTP 401) : plus rien n’est envoyé tant que le nom d’utilisateur ou le mot de
  passe n’est pas enregistré à nouveau dans le formulaire (le mot de passe
  enregistré est alors essayé une fois, même identique) ; le bouton **Tester la
  connexion** essaie une fois de plus, quand une lecture est due. Après un
  refus, **aucune connexion** pendant 5 minutes, puis 10, 20... (6 heures au
  plus) pour chaque refus d’affilée, gardé à travers les redémarrages :
  fail2ban sur le serveur bannit une adresse après quelques connexions
  refusées. Gladys garde un marqueur de 8 bits du mot de passe refusé (partagé
  par 1 mot de passe sur 256, jamais le mot de passe) pour qu’un redémarrage
  ne le réessaie pas.
- **HTTP 403** (la liste d’autorisation de l’administration web) : dit comme
  tel, réessayé, jamais un refus du mot de passe.
- **HTTP 429 ou 5xx** sur la connexion ou sur la route des versions : une pause
  de toutes les requêtes (au moins l’intervalle de rafraîchissement, jusqu’à 6 heures, ou ce que le serveur demande),
  gardée à travers les redémarrages. Les autres routes (mises à jour,
  services, diagnostic, sauvegardes) ne mettent jamais en pause ni n’arrêtent
  la lecture (sauf un certificat ou une connexion refusés, qui arrêtent tout
  où qu’ils se présentent) : ce qu’elles n’ont pas donné cette fois est dit
  dans l’état, et une route en échec est redemandée 1, 2, 4... lectures plus
  tard, 6 heures au plus d’écart.
- **Pas de réponse** : nouvel essai après l’intervalle de rafraîchissement,
  puis deux fois plus long à chaque fois, jusqu’à une heure. Après une
  connexion refusée, l’état ajoute que fail2ban bannit peut-être Gladys.

Ni le mot de passe ni le cookie de session ne sont journalisés ni publiés ;
les domaines, noms d’applications et messages du serveur non plus. Le stockage
garde l’empreinte du certificat, le marqueur de 8 bits ci-dessus, l’attente de
connexion, la pause et l’heure du dernier appui de chaque action.

## Pas fait (pour l’instant)

Rafraîchir les listes de mises à jour, lancer le diagnostic, la place libre
sur le disque, la liste des applications et leurs versions, les domaines et
leurs certificats : dites-le sur le forum si vous en avez besoin.
