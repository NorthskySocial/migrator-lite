import {
  CompositeHandleResolver,
  DohJsonHandleResolver,
  WellKnownHandleResolver,
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver
} from '@atcute/identity-resolver';
import {AtpAgent} from '@atproto/api';

const handleResolver = new CompositeHandleResolver({
  strategy: 'race',
  methods: {
    dns: new DohJsonHandleResolver({dohUrl: 'https://mozilla.cloudflare-dns.com/dns-query'}),
    http: new WellKnownHandleResolver(),
  },
});

const docResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});


function safeStatusUpdate(statusUpdateHandler, status) {
  if (statusUpdateHandler) {
    statusUpdateHandler(status);
  }
}


class Migrator {
  constructor() {
    this.oldAgent = null;
    this.newAgent = null;
    this.missingBlobs = [];
    //State for reruns
    this.createNewAccount = true;
    this.migrateRepo = true;
    this.migrateBlobs = true;
    this.migrateMissingBlobs = true;
    this.migratePrefs = true;
    this.migratePlcRecord = true;
  }

  /**
     * This migrator is pretty cut and dry and makes a few assumptions
     * 1. You are using the same password between each account
     * 2. If this command fails for something like oauth 2fa code it throws an error and expects the same values when ran again.
     * @param {string} oldHandle - The handle you use on your old pds, something like alice.bsky.social
     * @param {string} password - Your password for your current login. Has to be your real password, no app password. When setting up a new account we reuse it as well for that account
     * @param {string} newPdsUrl - The new URL for your pds. Like https://coolnewpds.com
     * @param {string} newEmail - The email you want to use on the new pds (can be the same as the previous one as long as it's not already being used on the new pds)
     * @param {string} newHandle - The new handle you want, like alice.bsky.social, or if you already have a domain name set as a handle can use it myname.com.
     * @param {string|null} inviteCode - The invite code you got from the PDS you are migrating to. If null does not include one
     * @param {function|null} statusUpdateHandler - a function that takes a string used to update the UI. Like (status) => console.log(status)
     * @param {string|null} twoFactorCode - Optional, but needed if it fails with 2fa required
     */
  async migrate(oldHandle, password, newPdsUrl, newEmail, newHandle, inviteCode, statusUpdateHandler = null, twoFactorCode = null) {

    //Copying the handle from bsky website adds some random unicodes on
    oldHandle = oldHandle.replace('@', '').trim().replace(/[\u202A\u202C\u200E\u200F\u2066-\u2069]/g, '');
    let oldAgent;
    let usersDid;
    //If it's a bsky handle just go with the entryway and let it sort everything
    if (oldHandle.endsWith('.bsky.social')) {
      oldAgent = new AtpAgent({service: 'https://bsky.social'});
      const publicAgent = new AtpAgent({service: 'https://public.api.bsky.app'});
      const resolveIdentityFromEntryway = await publicAgent.com.atproto.identity.resolveHandle({handle: oldHandle});
      usersDid = resolveIdentityFromEntryway.data.did;

    } else {
      //Resolves the did and finds the did document for the old PDS
      safeStatusUpdate(statusUpdateHandler, 'Resolving old PDS');
      usersDid = await handleResolver.resolve(oldHandle);
      const didDoc = await docResolver.resolve(usersDid);
      safeStatusUpdate(statusUpdateHandler, 'Resolving did document and finding your current PDS URL');

      let oldPds;
      try {
        oldPds = didDoc.service.filter(s => s.type === 'AtprotoPersonalDataServer')[0].serviceEndpoint;
      } catch (error) {
        console.error(error);
        throw new Error('Could not find a PDS in the DID document.');
      }

      oldAgent = new AtpAgent({
        service: oldPds,
      });

    }

    safeStatusUpdate(statusUpdateHandler, 'Logging you in to the old PDS');
    //Login to the old PDS
    if (twoFactorCode === null) {
      await oldAgent.login({identifier: oldHandle, password});
    } else {
      await oldAgent.login({identifier: oldHandle, password: password, authFactorToken: twoFactorCode});
    }

    safeStatusUpdate(statusUpdateHandler, 'Checking that the new PDS is an actual PDS (if the url is wrong this takes a while to error out)');
    const newAgent = new AtpAgent({service: newPdsUrl});
    const newHostDesc = await newAgent.com.atproto.server.describeServer();
    if (this.createNewAccount) {
      const newHostWebDid = newHostDesc.data.did;

      safeStatusUpdate(statusUpdateHandler, 'Creating a new account on the new PDS');

      const createAuthResp = await oldAgent.com.atproto.server.getServiceAuth({
        aud: newHostWebDid,
        lxm: 'com.atproto.server.createAccount',
      });
      const serviceJwt = createAuthResp.data.token;

      let createAccountRequest = {
        did: usersDid,
        handle: newHandle,
        email: newEmail,
        password: password,
      };
      if (inviteCode) {
        createAccountRequest.inviteCode = inviteCode;
      }
      const createNewAccount = await newAgent.com.atproto.server.createAccount(
        createAccountRequest,
        {
          headers: {authorization: `Bearer ${serviceJwt}`},
          encoding: 'application/json',
        });

      if (createNewAccount.data.did !== usersDid.toString()) {
        throw new Error('Did not create the new account with the same did as the old account');
      }
    }
    safeStatusUpdate(statusUpdateHandler, 'Logging in with the new account');

    await newAgent.login({
      identifier: usersDid,
      password: password,
    });

    if (this.migrateRepo) {
      safeStatusUpdate(statusUpdateHandler, 'Migrating your repo');
      const repoRes = await oldAgent.com.atproto.sync.getRepo({did: usersDid});
      await newAgent.com.atproto.repo.importRepo(repoRes.data, {
        encoding: 'application/vnd.ipld.car',
      });
    }

    let newAccountStatus = await newAgent.com.atproto.server.checkAccountStatus();

    if (this.migrateBlobs) {
      safeStatusUpdate(statusUpdateHandler, 'Migrating your blobs');

      let blobCursor = undefined;
      let uploadedBlobs = 0;
      do {
        safeStatusUpdate(statusUpdateHandler, `Migrating blobs: ${uploadedBlobs}/${newAccountStatus.data.expectedBlobs}`);

        const listedBlobs = await oldAgent.com.atproto.sync.listBlobs({
          did: usersDid,
          cursor: blobCursor,
          limit: 100,
        });

        for (const cid of listedBlobs.data.cids) {
          try {
            const blobRes = await oldAgent.com.atproto.sync.getBlob({
              did: usersDid,
              cid,
            });
            await newAgent.com.atproto.repo.uploadBlob(blobRes.data, {
              encoding: blobRes.headers['content-type'],
            });
            uploadedBlobs++;
            if (uploadedBlobs % 10 === 0) {
              safeStatusUpdate(statusUpdateHandler, `Migrating blobs: ${uploadedBlobs}/${newAccountStatus.data.expectedBlobs}`);
            }
          } catch (error) {
            console.error(error);
          }
        }
        blobCursor = listedBlobs.data.cursor;
      } while (blobCursor);
    }

    if (this.migrateMissingBlobs) {
      newAccountStatus = await newAgent.com.atproto.server.checkAccountStatus();
      if (newAccountStatus.data.expectedBlobs !== newAccountStatus.data.importedBlobs) {
        let totalMissingBlobs = newAccountStatus.data.expectedBlobs - newAccountStatus.data.importedBlobs;
        safeStatusUpdate(statusUpdateHandler, 'Looks like there are some missing blobs. Going to try and upload them now.');
        //Probably should be shared between main blob uploader, but eh
        let missingBlobCursor = undefined;
        let missingUploadedBlobs = 0;
        do {
          safeStatusUpdate(statusUpdateHandler, `Migrating blobs: ${missingUploadedBlobs}/${totalMissingBlobs}`);

          const missingBlobs = await newAgent.com.atproto.repo.listMissingBlobs({
            cursor: missingBlobCursor,
            limit: 100,
          });

          for (const recordBlob of missingBlobs.data.blobs) {
            try {

              const blobRes = await oldAgent.com.atproto.sync.getBlob({
                did: usersDid,
                cid: recordBlob.cid,
              });
              await newAgent.com.atproto.repo.uploadBlob(blobRes.data, {
                encoding: blobRes.headers['content-type'],
              });
              if (missingUploadedBlobs % 10 === 0) {
                safeStatusUpdate(statusUpdateHandler, `Migrating blobs: ${missingUploadedBlobs}/${totalMissingBlobs}`);
              }
              missingUploadedBlobs++;
            } catch (error) {
              //TODO silently logging prob should list them so user can manually download
              console.error(error);
              this.missingBlobs.push(recordBlob.cid);
            }
          }
          missingBlobCursor = missingBlobs.data.cursor;
        } while (missingBlobCursor);

      }
    }
    if (this.migratePrefs) {
      const prefs = await oldAgent.app.bsky.actor.getPreferences();
      await newAgent.app.bsky.actor.putPreferences(prefs.data);
    }

    this.oldAgent = oldAgent;
    this.newAgent = newAgent;

    if (this.migratePlcRecord) {
      await oldAgent.com.atproto.identity.requestPlcOperationSignature();
      safeStatusUpdate(statusUpdateHandler, 'Please check your email for a PLC token');
    }
  }

  /**
     *  Sign and submits the PLC operation to officially migrate the account
     * @param {string} token - the PLC token sent in the email. If you're just wanting to run this rerun migrate with all the flags set as false except for migratePlcRecord
     * @returns {Promise<void>}
     */
  async signPlcOperation(token) {
    const getDidCredentials =
            await this.newAgent.com.atproto.identity.getRecommendedDidCredentials();
    const rotationKeys = getDidCredentials.data.rotationKeys ?? [];
    if (!rotationKeys) {
      throw new Error('No rotation key provided from the new PDS');
    }
    const credentials = {
      ...getDidCredentials.data,
      rotationKeys: rotationKeys,
    };


    const plcOp = await this.oldAgent.com.atproto.identity.signPlcOperation({
      token: token,
      ...credentials,
    });

    await this.newAgent.com.atproto.identity.submitPlcOperation({
      operation: plcOp.data.operation,
    });

    await this.newAgent.com.atproto.server.activateAccount();
    await this.oldAgent.com.atproto.server.deactivateAccount({});
  }

  // Quick and dirty copy and paste of the above to get a fix out to help people without breaking or introducing any bugs to the migration service...hopefully
  async deactivateOldAccount(oldHandle, oldPassword, statusUpdateHandler = null, twoFactorCode = null) {
    //Copying the handle from bsky website adds some random unicodes on
    oldHandle = oldHandle.replace('@', '').trim().replace(/[\u202A\u202C\u200E\u200F\u2066-\u2069]/g, '');
    let usersDid;
    //If it's a bsky handle just go with the entryway and let it sort everything
    if (oldHandle.endsWith('.bsky.social')) {
      const publicAgent = new AtpAgent({service: 'https://public.api.bsky.app'});
      const resolveIdentityFromEntryway = await publicAgent.com.atproto.identity.resolveHandle({handle: oldHandle});
      usersDid = resolveIdentityFromEntryway.data.did;
    } else {
      //Resolves the did and finds the did document for the old PDS
      safeStatusUpdate(statusUpdateHandler, 'Resolving did from handle');
      usersDid = await handleResolver.resolve(oldHandle);
    }

    const didDoc = await docResolver.resolve(usersDid);
    let currentPds;
    try {
      currentPds = didDoc.service.filter(s => s.type === 'AtprotoPersonalDataServer')[0].serviceEndpoint;
    } catch (error) {
      console.error(error);
      throw new Error('Could not find a PDS in the DID document.');
    }

    const plcLogRequest = await fetch(`https://plc.directory/${usersDid}/log`);
    const plcLog = await plcLogRequest.json();
    let pdsBeforeCurrent = '';
    for (const log of plcLog) {
      try {
        const pds = log.services.atproto_pds.endpoint;
        console.log(pds);
        if (pds.toLowerCase() === currentPds.toLowerCase()) {
          console.log('Found the PDS before the current one');
          break;
        }
        pdsBeforeCurrent = pds;
      } catch (e) {
        console.log(e);
      }
    }
    if (pdsBeforeCurrent === '') {
      throw new Error('Could not find the PDS before the current one');
    }

    let oldAgent = new AtpAgent({service: pdsBeforeCurrent});
    safeStatusUpdate(statusUpdateHandler, `Logging you in to the old PDS: ${pdsBeforeCurrent}`);
    //Login to the old PDS
    if (twoFactorCode === null) {
      await oldAgent.login({identifier: oldHandle, password: oldPassword});
    } else {
      await oldAgent.login({identifier: oldHandle, password: oldPassword, authFactorToken: twoFactorCode});
    }
    safeStatusUpdate(statusUpdateHandler, 'Checking this isn\'t your current PDS');
    if (pdsBeforeCurrent === currentPds) {
      throw new Error('This is your current PDS. Login to your old account username and password');
    }

    let currentAccountStatus = await oldAgent.com.atproto.server.checkAccountStatus();
    if (!currentAccountStatus.data.activated) {
      safeStatusUpdate(statusUpdateHandler, 'All good. Your old account is not activated.');
    }
    safeStatusUpdate(statusUpdateHandler, 'Deactivating your OLD account');
    await oldAgent.com.atproto.server.deactivateAccount({});
    safeStatusUpdate(statusUpdateHandler, 'Successfully deactivated your OLD account');
  }
}

export {Migrator};
