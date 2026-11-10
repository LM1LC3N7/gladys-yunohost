// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds the
// password, the session cookie, a domain name nor an entry typed by the user;
// the certificate fingerprint met is shown (not a secret: the server shows it
// to anyone), so that the user can compare it with the one of the server.
// -----------------------------------------------------------------------------

import { CODES } from './ynh/errors.js';

/** A delay in words: seconds under a minute, then whole minutes (59.9 s is "1 min"). */
export function delayOf(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return { en: `${seconds} s`, fr: `${seconds} s` };
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return { en: `${minutes} min`, fr: `${minutes} min` };
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

/** Why the server failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.LATE:
      return { en: 'too late to send', fr: 'trop tard pour envoyer' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.CREDENTIALS:
      return { en: 'user name or password refused', fr: 'identifiants refusés' };
    case CODES.LOGIN_GATE:
      return { en: 'login waiting after a refusal', fr: 'connexion en attente après un refus' };
    case CODES.ACCESS:
      return { en: 'session refused after login', fr: 'session refusée après connexion' };
    case CODES.FORBIDDEN:
      return { en: 'access forbidden (HTTP 403)', fr: 'accès interdit (HTTP 403)' };
    case CODES.REDIRECT:
      return { en: 'redirection', fr: 'redirection' };
    case CODES.CERTIFICATE:
    case CODES.CERTIFICATE_TYPED:
      return { en: 'another HTTPS certificate', fr: 'autre certificat HTTPS' };
    case CODES.PIN_UNAVAILABLE:
      return { en: 'certificate cannot be kept', fr: 'certificat impossible à garder' };
    case CODES.TLS:
      return { en: 'TLS refused', fr: 'TLS refusé' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

export const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

const retry = (delay) => ({
  en: `Retried in ${delayOf(delay).en}.`,
  fr: `Nouvel essai dans ${delayOf(delay).fr}.`,
});

const SAVE_TO_RETRY = {
  en: 'Nothing is sent to the server until the user name or the password is saved again.',
  fr: 'Plus rien n’est envoyé au serveur tant que le nom d’utilisateur ou le mot de passe n’est pas enregistré à nouveau.',
};

const MISSING = {
  updates: { en: 'updates', fr: 'mises à jour' },
  services: { en: 'services', fr: 'services' },
  diagnosis: { en: 'diagnosis', fr: 'diagnostic' },
  backups: { en: 'backups', fr: 'sauvegardes' },
};

const TRUST = {
  en: 'If you renewed or replaced the certificate (Let’s Encrypt renews it every two or three months), check this fingerprint in the web admin of YunoHost (or with your browser), then press "Trust the certificate met" twice, or type it in the "Certificate fingerprint" field.',
  fr: 'Si vous avez renouvelé ou remplacé le certificat (Let’s Encrypt le renouvelle tous les deux ou trois mois), vérifiez cette empreinte dans l’administration de YunoHost (ou avec votre navigateur), puis appuyez deux fois sur « Faire confiance au certificat rencontré », ou saisissez-la dans le champ « Empreinte du certificat ».',
};

/** The names of the actions, in the texts. */
export const ACTION_NAMES = {
  upgrade_system: 'System upgrade',
  upgrade_apps: 'Apps upgrade',
  backup: 'Backup',
  restart: 'Restart',
};

export const T = {
  status: {
    ok: ({ version, updates, down, missing = [], running }) =>
      join(
        {
          en: `YunoHost ${version ?? '?'} answers: ${updates ?? '?'} upgrade(s) waiting, ${down ?? '?'} service(s) down.`,
          fr: `YunoHost ${version ?? '?'} répond : ${updates ?? '?'} mise(s) à jour en attente, ${down ?? '?'} service(s) arrêté(s).`,
        },
        missing.length > 0
          ? {
              en: `Not read this time: ${missing.map((m) => MISSING[m]?.en ?? m).join(', ')}.`,
              fr: `Non lu cette fois : ${missing.map((m) => MISSING[m]?.fr ?? m).join(', ')}.`,
            }
          : {},
        running
          ? {
              en: `Running: ${running.toLowerCase()}.`,
              fr: `En cours : ${running.toLowerCase()}.`,
            }
          : {},
      ),
    waiting: (delay) => ({
      en: `Started: the server is read in ${delayOf(delay).en} (never sooner than the refresh interval).`,
      fr: `Démarré : le serveur est lu dans ${delayOf(delay).fr} (jamais avant l’intervalle de rafraîchissement).`,
    }),
    hostMissing: {
      en: 'Enter the address of the YunoHost server.',
      fr: 'Saisissez l’adresse du serveur YunoHost.',
    },
    hostInvalid: {
      en: 'The address of the server is not valid (an IP address or a host name, with an optional https:// and port).',
      fr: 'L’adresse du serveur n’est pas valide (une adresse IP ou un nom d’hôte, avec https:// et un port facultatifs).',
    },
    hostHttp: {
      en: 'The administration of YunoHost is only reached in HTTPS: enter the address without http:// (or with https://).',
      fr: 'L’administration de YunoHost ne se joint qu’en HTTPS : saisissez l’adresse sans http:// (ou avec https://).',
    },
    usernameMissing: {
      en: 'Enter the user name of a YunoHost administrator.',
      fr: 'Saisissez le nom d’utilisateur d’un administrateur YunoHost.',
    },
    usernameInvalid: {
      en: 'The user name is not valid (a YunoHost user name: lower case letters, digits, _ - .).',
      fr: 'Le nom d’utilisateur n’est pas valide (un nom d’utilisateur YunoHost : minuscules, chiffres, _ - .).',
    },
    missingPassword: {
      en: 'Enter the password of the administrator.',
      fr: 'Saisissez le mot de passe de l’administrateur.',
    },
    passwordInvalid: {
      en: 'The password holds a line break or a control character (pasted by mistake?): it was not sent.',
      fr: 'Le mot de passe contient un retour à la ligne ou un caractère de contrôle (collé par erreur ?) : il n’a pas été envoyé.',
    },
    fingerprintInvalid: {
      en: 'The certificate fingerprint is not a SHA-256 fingerprint (64 hexadecimal digits, colons allowed).',
      fr: 'L’empreinte du certificat n’est pas une empreinte SHA-256 (64 chiffres hexadécimaux, deux-points permis).',
    },
    servicesInvalid: {
      en: 'The list of services Gladys may restart is not valid (service names separated by commas, 16 at most).',
      fr: 'La liste des services que Gladys peut redémarrer n’est pas valide (noms de services séparés par des virgules, 16 au plus).',
    },
    credentialsRefused: join(
      {
        en: 'YunoHost refused the user name or the password.',
        fr: 'YunoHost a refusé le nom d’utilisateur ou le mot de passe.',
      },
      SAVE_TO_RETRY,
      {
        en: 'The "Test the connection" button tries once more, at most once every few minutes (fail2ban bans an address after a few refusals).',
        fr: 'Le bouton « Tester la connexion » essaie une fois de plus, au plus une fois toutes les quelques minutes (fail2ban bannit une adresse après quelques refus).',
      },
    ),
    loginGate: (delay) => ({
      en: `A login was refused a moment ago: no other login for ${delayOf(delay).en}, so that fail2ban does not ban Gladys.`,
      fr: `Une connexion a été refusée il y a peu : aucune autre connexion pendant ${delayOf(delay).fr}, pour que fail2ban ne bannisse pas Gladys.`,
    }),
    certificateChanged: (fingerprint) =>
      join(
        {
          en: `The server presents another HTTPS certificate than the one learned (SHA-256 ${fingerprint}). Nothing was sent.`,
          fr: `Le serveur présente un autre certificat HTTPS que celui appris (SHA-256 ${fingerprint}). Rien n’a été envoyé.`,
        },
        TRUST,
      ),
    certificateTyped: (fingerprint) => ({
      en: `The HTTPS certificate of the server is not the fingerprint you typed (it presents SHA-256 ${fingerprint}). Nothing was sent.`,
      fr: `Le certificat HTTPS du serveur n’est pas l’empreinte saisie (il présente SHA-256 ${fingerprint}). Rien n’a été envoyé.`,
    }),
    pinUnavailable: (reason, fingerprint) =>
      reason === 'unreadable'
        ? {
            en: `The storage of the integration (/data) cannot be read: the certificate of the server is not learned blindly. Nothing was sent; /data is read again every 10 s. You may type the fingerprint of the server (SHA-256 ${fingerprint}, check it first) in the "Certificate fingerprint" field.`,
            fr: `Le stockage de l’intégration (/data) est illisible : le certificat du serveur n’est pas appris à l’aveugle. Rien n’a été envoyé ; /data est relu toutes les 10 s. Vous pouvez saisir l’empreinte du serveur (SHA-256 ${fingerprint}, à vérifier d’abord) dans le champ « Empreinte du certificat ».`,
          }
        : {
            en: `The certificate of the server cannot be kept (/data cannot be written): nothing was sent. Type its fingerprint (SHA-256 ${fingerprint}, check it first) in the "Certificate fingerprint" field.`,
            fr: `Le certificat du serveur ne peut pas être gardé (/data non inscriptible) : rien n’a été envoyé. Saisissez son empreinte (SHA-256 ${fingerprint}, à vérifier d’abord) dans le champ « Empreinte du certificat ».`,
          },
    paused: (status, delay) => ({
      en: `The server asked to wait (HTTP ${status}): no request for ${delayOf(delay).en}.`,
      fr: `Le serveur a demandé d’attendre (HTTP ${status}) : aucune requête pendant ${delayOf(delay).fr}.`,
    }),
    forbidden: (delay) =>
      join(
        {
          en: 'The server refuses the address of Gladys (HTTP 403): if the "allowlist" of the web admin is on in YunoHost, add the address of Gladys to it.',
          fr: 'Le serveur refuse l’adresse de Gladys (HTTP 403) : si la « liste d’autorisation » de l’administration web est active dans YunoHost, ajoutez-y l’adresse de Gladys.',
        },
        retry(delay),
      ),
    tls: (delay) =>
      join(
        {
          en: 'The server refused the TLS handshake.',
          fr: 'Le serveur a refusé la négociation TLS.',
        },
        retry(delay),
      ),
    failure: (err, delay, { banHint = false, action = null } = {}) =>
      join(
        { en: 'The server cannot be read:', fr: 'Le serveur ne peut pas être lu :' },
        { en: `${reasonOf(err).en}.`, fr: `${reasonOf(err).fr}.` },
        action
          ? {
              en: `An action is running (${action.toLowerCase()}): YunoHost may be restarting its API.`,
              fr: `Une action est en cours (${action.toLowerCase()}) : YunoHost redémarre peut-être son API.`,
            }
          : {},
        banHint
          ? {
              en: 'A login was refused lately: fail2ban may be banning the address of Gladys for a while.',
              fr: 'Une connexion a été refusée récemment : fail2ban bannit peut-être l’adresse de Gladys pour un temps.',
            }
          : {},
        retry(delay),
      ),
    configNotRead: (delay) => ({
      en: `Gladys did not give the configuration: asked again in ${delayOf(delay).en}.`,
      fr: `Gladys n’a pas donné la configuration : nouvelle demande dans ${delayOf(delay).fr}.`,
    }),
  },
  test: {
    ok: (status) =>
      join(status, {
        en: 'Connection working.',
        fr: 'Connexion fonctionnelle.',
      }),
  },
  trust: {
    nothing: {
      en: 'The certificate of the server is not refused: there is nothing to trust.',
      fr: 'Le certificat du serveur n’est pas refusé : il n’y a rien à approuver.',
    },
    typed: {
      en: 'A fingerprint is typed in the configuration: it is the one trusted. Change it there.',
      fr: 'Une empreinte est saisie dans la configuration : c’est elle qui fait foi. Modifiez-la là.',
    },
    confirm: (fingerprint) => ({
      en: `The server presents SHA-256 ${fingerprint}. Check it, then press this button again within 2 minutes to trust it.`,
      fr: `Le serveur présente SHA-256 ${fingerprint}. Vérifiez-la, puis appuyez à nouveau sur ce bouton dans les 2 minutes pour lui faire confiance.`,
    }),
    done: (fingerprint) => ({
      en: `Certificate SHA-256 ${fingerprint} trusted: the server is read again.`,
      fr: `Certificat SHA-256 ${fingerprint} approuvé : le serveur est relu.`,
    }),
    notKept: {
      en: 'The certificate cannot be kept (/data cannot be written or read): nothing changed. Type its fingerprint in the configuration instead.',
      fr: 'Le certificat ne peut pas être gardé (/data illisible ou non inscriptible) : rien n’a changé. Saisissez plutôt son empreinte dans la configuration.',
    },
  },
  errors: {
    unknownDevice: 'Unknown device or feature',
    readOnly: 'This value is read only: only the buttons act',
    badValue: 'A button only takes the value 1',
    upgradesDisabled:
      'Upgrades are disabled: turn on "Allow upgrades from Gladys" in the configuration',
    backupDisabled:
      'Backups are disabled: turn on "Allow backups from Gladys" in the configuration',
    restartDisabled: (name) =>
      `Restarting ${name} is not allowed: add it to "Services Gladys may restart" in the configuration`,
    stillRunning: (what) => `An action is already running (${what.toLowerCase()}): nothing sent`,
    notConnected: 'The server is not configured or a stop stands (see the status): nothing sent',
    dataUnreadable:
      'The storage /data cannot be read (the delay between two actions): nothing sent',
    paused: (delay) => `The server asked to wait: nothing sent for ${delayOf(delay).en}`,
    cooldown: (what, delay) =>
      `${what} was sent a short while ago: nothing sent, try again in ${delayOf(delay).en}`,
    tooSlow: 'The server did not answer in time: nothing sent',
    cooldownNotKept: 'The delay between two actions cannot be kept in /data: nothing sent',
    unknownState: (reason) => `The server could not be read just before (${reason}): nothing sent`,
    unknownService: (name) => `YunoHost does not know the service ${name}: nothing sent`,
    notSent: (what, reason) => `${what} not sent (${reason})`,
    refused: (what, reason) => `YunoHost refused: ${what.toLowerCase()} (${reason})`,
    sentUnconfirmed: (what, reason) =>
      `${what} sent, without an answer from YunoHost yet (${reason}): see "Last action"`,
    testTooLong: 'The test took too long',
  },
};
