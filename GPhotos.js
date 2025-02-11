"use strict";

const EventEmitter = require("events");
const util = require("util");
const opn = require("open");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { mkdirp } = require("mkdirp");
const { OAuth2Client } = require("google-auth-library");
const Axios = require("axios");
const moment = require("moment");

/**
 *
 * @param ms
 */
function sleep(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class Auth extends EventEmitter {
  #config;
  #debug = {};

  constructor(config, debug = false) {
    super();
    this.#config = config;
    this.#debug = debug;
    this.init();
  }

  async init() {
    const log = this.#debug
      ? (...args) => {
          console.log("[GPHOTOS:AUTH]", ...args);
        }
      : () => {};
    if (this.#config === undefined) config = {};
    if (this.#config.keyFilePath === undefined) {
      throw new Error('Missing "keyFilePath" from config (This should be where your Credential file is)');
    }
    if (this.#config.savedTokensPath === undefined) {
      throw new Error('Missing "savedTokensPath" from config (this should be where your OAuth2 access tokens will be saved)');
    }
    let creds = path.resolve(__dirname, this.#config.keyFilePath);
    if (!fs.existsSync(creds)) {
      throw new Error("Missing Credentials.");
    }
    const key = require(this.#config.keyFilePath).installed;
    const oauthClient = new OAuth2Client(key.client_id, key.client_secret, key.redirect_uris[0]);
    let tokensCred;
    const saveTokens = async (first = false) => {
      oauthClient.setCredentials(tokensCred);
      let expired = false;
      let now = Date.now();
      if (tokensCred.expiry_date < Date.now()) {
        expired = true;
        log("Token is expired.");
      }
      if (expired || first) {
        const tk = await oauthClient.refreshAccessToken();
        tokensCred = tk.credentials;
        let tp = path.resolve(__dirname, this.#config.savedTokensPath);
        await mkdirp(path.dirname(tp));
        fs.writeFileSync(tp, JSON.stringify(tokensCred));
        log("Token is refreshed.");
        this.emit("ready", oauthClient);
      } else {
        log("Token is alive.");
        this.emit("ready", oauthClient);
      }
    };

    const getTokens = () => {
      const url = oauthClient.generateAuthUrl({
        access_type: "offline",
        scope: [this.#config.scope],
      });
      log("Opening OAuth URL.\n\n" + url + "\n\nReturn here with your code.");
      opn(url).catch(() => {
        log("Failed to automatically open the URL. Copy/paste this in your browser:\n", url);
      });
      if (typeof this.#config.tokenInput === "function") {
        this.#config.tokenInput(processTokens);
        return;
      }
      const reader = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      reader.question("> Paste your code: ", processTokens);
    };
    const processTokens = async (oauthCode) => {
      if (!oauthCode) process.exit(-1);
      try {
        const tkns = await oauthClient.getToken(oauthCode);
        tokensCred = tkns;
        await saveTokens(true);
      } catch (error) {
        throw new Error("Error getting tokens:", error);
      }
    };
    process.nextTick(() => {
      if (this.#config.savedTokensPath) {
        try {
          let file = path.resolve(__dirname, this.#config.savedTokensPath);
          const tokensFile = fs.readFileSync(file);
          tokensCred = JSON.parse(tokensFile);
        } catch (error) {
          getTokens();
        } finally {
          if (tokensCred !== undefined) saveTokens();
        }
      }
    });
  }
}

class GPhotos {
  constructor(options) {
    this.debug = false;
    if (!options.hasOwnProperty("authOption")) {
      throw new Error("Invalid auth information.");
    }
    this.options = options;
    this.debug = options.debug ? options.debug : this.debug;
    this.albums = {
      album: [],
      shared: [],
    };
  }

  log(...args) {
    if (this.debug) console.log("[GPHOTOS:CORE]", ...args);
  }

  logError(...args) {
    if (this.debug) console.error("[GPHOTOS:CORE]", ...args);
  }

  onAuthReady(job = () => {}) {
    let auth = null;
    try {
      auth = new Auth(this.options.authOption, this.debug);
    } catch (e) {
      this.log(e.toString());
      throw e;
    }
    auth.on("ready", (client) => {
      job(client);
    });
  }

  generateToken(success = () => {}, fail = () => {}) {
    this.onAuthReady((client) => {
      const isTokenFileExist = () => {
        let fp = path.resolve(__dirname, this.options.authOption.savedTokensPath);
        if (fs.existsSync(fp)) return true;
        return false;
      };
      if (isTokenFileExist()) success();
      fail();
    });
  }

  request(token, endPoint = "", method = "get", params = null, data = null) {
    return new Promise((resolve) => {
      try {
        let url = endPoint;
        let config = {
          method: method,
          url: url,
          baseURL: "https://photoslibrary.googleapis.com/v1/",
          headers: {
            Authorization: "Bearer " + token,
          },
        };
        if (params) config.params = params;
        if (data) config.data = data;
        Axios(config)
          .then((ret) => {
            resolve(ret);
          })
          .catch((e) => {
            this.logError("request fail with URL", url);
            this.logError(e.toString());
            throw e;
          });
      } catch (error) {
        this.log(error.toString());
        throw error;
      }
    });
  }

  getAlbums() {
    return new Promise((resolve) => {
      const step = async () => {
        let albums = await this.getAlbumType("albums");
        let shared = await this.getAlbumType("sharedAlbums");
        for (let s of shared) {
          let isExist = albums.find((a) => {
            if (a.id === s.id) return true;
            return false;
          });
          if (!isExist) albums.push(s);
        }
        resolve(albums);
      };
      step();
    });
  }

  getAlbumType(type = "albums") {
    if (type !== "albums" && type !== "sharedAlbums") throw new Error("Invalid parameter for .getAlbumType()", type);
    return new Promise((resolve) => {
      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        let list = [];
        let found = 0;
        const getAlbum = async (pageSize = 50, pageToken = "") => {
          this.log("Getting Album info chunks.");
          let params = {
            pageSize: pageSize,
            pageToken: pageToken,
          };
          try {
            let response = await this.request(token, type, "get", params, null);
            let body = response.data;
            if (body[type] && Array.isArray(body[type])) {
              found += body[type].length;
              list = list.concat(body[type]);
            }
            if (body.nextPageToken) {
              const generous = async () => {
                await sleep(500);
                getAlbum(pageSize, body.nextPageToken);
              };
              generous();
            } else {
              this.albums[type] = list;
              resolve(list);
            }
          } catch (err) {
            this.log(err.toString());
            throw err;
          }
        };
        getAlbum();
      });
    });
  }

  getImageFromAlbum(albumId, isValid = null, maxNum = 99999) {
    return new Promise((resolve) => {
      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        let list = [];
        const getImage = async (pageSize = 50, pageToken = "") => {
          this.log("Indexing photos now. total: ", list.length);
          try {
            let data = {
              albumId: albumId,
              pageSize: pageSize,
              pageToken: pageToken,
            };
            let response = await this.request(token, "mediaItems:search", "post", null, data);
            if (response.data.hasOwnProperty("mediaItems") && Array.isArray(response.data.mediaItems)) {
              for (let item of response.data.mediaItems) {
                if (list.length < maxNum) {
                  item._albumId = albumId;
                  if (typeof isValid === "function") {
                    if (isValid(item)) list.push(item);
                  } else {
                    list.push(item);
                  }
                }
              }
              if (list.length >= maxNum) {
                resolve(list); // full with maxNum
              } else {
                if (response.data.nextPageToken) {
                  const generous = async () => {
                    await sleep(500);
                    getImage(50, response.data.nextPageToken);
                  };
                  generous();
                } else {
                  resolve(list); // all found but lesser than maxNum
                }
              }
            } else {
              resolve(list); // empty
            }
          } catch (err) {
            this.log(".getImageFromAlbum()", err.toString());
            this.log(err);
            throw err;
          }
        };
        getImage();
      });
    });
  }

  async updateTheseMediaItems(items) {
    return new Promise((resolve) => {
      if (items.length <= 0) {
        resolve(items);
      }

      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        this.log("received: ", items.length, " to refresh"); //
        let list = [];
        let params = new URLSearchParams();
        let ii;
        for (ii in items) {
          params.append("mediaItemIds", items[ii].id);
        }

        const refr = async () => {
          let response = await this.request(token, "mediaItems:batchGet", "get", params, null);

          if (response.data.hasOwnProperty("mediaItemResults") && Array.isArray(response.data.mediaItemResults)) {
            for (let i = 0; i < response.data.mediaItemResults.length; i++) {
              if (response.data.mediaItemResults[i].hasOwnProperty("mediaItem")) {
                items[i].baseUrl = response.data.mediaItemResults[i].mediaItem.baseUrl;
              }
            }

            resolve(items);
          }
        };
        refr();
      });
    });
  }

  createAlbum(albumName) {
    return new Promise((resolve) => {
      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        const create = async () => {
          try {
            let created = await this.request(token, "albums", "post", null, {
              album: {
                title: albumName,
              },
            });
            resolve(created.data);
          } catch (err) {
            this.log(".createAlbum() ", err.toString());
            this.log(err);
            throw err;
          }
        };
        create();
      });
    });
  }

  shareAlbum(albumId) {
    return new Promise((resolve) => {
      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        const create = async () => {
          try {
            let shareInfo = await this.request(token, "albums/" + albumId + ":share", "post", null, {
              sharedAlbumOptions: {
                isCollaborative: true,
                isCommentable: true,
              },
            });
            resolve(shareInfo.data);
          } catch (err) {
            this.log(".shareAlbum()", err.toString());
            this.log(err);
            throw err;
          }
        };
        create();
      });
    });
  }

  upload(path) {
    return new Promise((resolve) => {
      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        const upload = async () => {
          try {
            let newFile = fs.createReadStream(path);
            let url = "uploads";
            let option = {
              method: "post",
              url: url,
              baseURL: "https://photoslibrary.googleapis.com/v1/",
              headers: {
                Authorization: "Bearer " + token,
                "Content-type": "application/octet-stream",
                //X-Goog-Upload-Content-Type: mime-type
                "X-Goog-Upload-Protocol": "raw",
              },
            };
            option.data = newFile;
            Axios(option)
              .then((ret) => {
                resolve(ret.data);
              })
              .catch((e) => {
                this.log(".upload:resultResolving ", e.toString());
                this.log(e);
                throw e;
              });
          } catch (err) {
            this.log(".upload()", err.toString());
            this.log(err);
            throw err;
          }
        };
        upload();
      });
    });
  }

  create(uploadToken, albumId) {
    return new Promise((resolve) => {
      this.onAuthReady((client) => {
        let token = client.credentials.access_token;
        const create = async () => {
          try {
            let fileName = moment().format("[MM_]YYYYMMDD_HHmm");
            let result = await this.request(token, "mediaItems:batchCreate", "post", null, {
              albumId: albumId,
              newMediaItems: [
                {
                  description: "Uploaded by MMM-GooglePhotos",
                  simpleMediaItem: {
                    uploadToken: uploadToken,
                    fileName: fileName,
                  },
                },
              ],
              albumPosition: {
                position: "LAST_IN_ALBUM",
              },
            });
            resolve(result.data);
          } catch (err) {
            this.log(".create() ", err.toString());
            this.log(err);
            throw err;
          }
        };
        create();
      });
    });
  }
}

module.exports = GPhotos;
