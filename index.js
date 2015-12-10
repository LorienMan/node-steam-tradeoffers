module.exports = SteamTradeOffers;

var request = require('request').defaults({ timeout: 5000, pool: false, agent: false });
var cheerio = require('cheerio');
var Long = require('long');
var url = require('url');
var querystring = require('querystring');
var vm = require('vm');

require('util').inherits(SteamTradeOffers, require('events').EventEmitter);

function SteamTradeOffers() {
  require('events').EventEmitter.call(this);

  this._j = request.jar();
  this._request = request.defaults({ jar: this._j });
}

SteamTradeOffers.prototype.setup = function(options, callback) {
  this.sessionID = options.sessionID;

  options.webCookie.forEach(function(name) {
    setCookie.bind(this)(name);
  }.bind(this));

  if (options.PIN) {
    return parentalUnlock.bind(this)(options.PIN, function(error) {
      if (error) {
        if (typeof callback == 'function') {
          return callback(error);
        } else {
          throw error;
        }
      }
      getAPIKey.bind(this)(callback);
    }.bind(this));
  }
  getAPIKey.bind(this)(callback);
};

function parentalUnlock(PIN, callback) {
  this._request.post({
    uri: 'https://steamcommunity.com/parental/ajaxunlock',
    json: true,
    headers: {
      referer: 'https://steamcommunity.com/'
    },
    form: {
      pin: PIN
    }
  }, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'family view: ' + (error || response.statusCode));
      return callback(error || new Error(response.statusCode));
    }
    if (!body || typeof body.success != 'boolean') {
      this.emit('debug', 'family view: invalid response');
      return callback(new Error('Invalid Response'));
    }
    if (!body.success) {
      this.emit('debug', 'family view: incorrect PIN code');
      return callback(new Error('Incorrect PIN'));
    }

    callback();
  }.bind(this));
}

function getAPIKey(callback) {
  if (this.APIKey) {
    if (typeof callback == 'function') {
      callback();
    }
    return;
  }
  this._request.get({
    uri: 'https://steamcommunity.com/dev/apikey'
  }, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'retrieving apikey: ' + (error || response.statusCode));
      if (typeof callback == 'function') {
        callback(error || new Error(response.statusCode));
      }
      return;
    }

    var $ = cheerio.load(body);

    if ($('#mainContents h2').html() == 'Access Denied') {
      this.emit('debug', 'retrieving apikey: access denied (probably limited account)');
      var accessError = new Error('Access Denied');
      if (typeof callback == 'function') {
        return callback(accessError);
      } else {
        throw accessError;
      }
    }
    if ($('#bodyContents_ex h2').html() == 'Your Steam Web API Key') {
      var key = $('#bodyContents_ex p').html().split(' ')[1];
      this.APIKey = key;
      if (typeof callback == 'function') {
        callback();
      }
      return;
    }

    this._request.post({
      uri: 'https://steamcommunity.com/dev/registerkey',
      form: {
        domain: 'localhost',
        agreeToTerms: 1
      }
    }, function(error, response, body) {
      getAPIKey.bind(this)(callback);
    }.bind(this));
  }.bind(this));
}

SteamTradeOffers.prototype.getOfferToken = function(callback) {
  this._request.get({
    uri: 'https://steamcommunity.com/id/me/tradeoffers/privacy'
  }, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'retrieving offer token: ' + (error || response.statusCode));
      return callback(error || new Error(response.statusCode));
    }
    if (!body) {
      this.emit('debug', 'retrieving offer token: invalid response');
      return callback(new Error('Invalid Response'));
    }

    var $ = cheerio.load(body);
    var offerUrl = $('input#trade_offer_access_url').val();
    var offerToken = url.parse(offerUrl, true).query.token;

    callback(null, offerToken);
  }.bind(this));
};

function setCookie(cookie) {
  this._j.setCookie(request.cookie(cookie), 'https://steamcommunity.com');
}

SteamTradeOffers.prototype._loadInventory = function(inventory, uri, options, contextid, start, callback) {
  options.uri = uri;
  
  if (start) {
    options.uri = options.uri + '&' + querystring.stringify({ 'start': start });
  }

  this._request.get(options, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'loading inventory: ' + (error || response.statusCode != 200));
      return callback(error || new Error(response.statusCode));
    }
    if (!body || !body.rgInventory || !body.rgDescriptions || !body.rgCurrency) {
      this.emit('debug', 'loading inventory: invalid response');
      return callback(new Error(403));
    }

    inventory = inventory.concat(mergeWithDescriptions(body.rgInventory, body.rgDescriptions, contextid)
      .concat(mergeWithDescriptions(body.rgCurrency, body.rgDescriptions, contextid)));
    if (body.more) {
      this._loadInventory(inventory, uri, options, contextid, body.more_start, callback);
    } else {
      callback(null, inventory);
    }
  }.bind(this));
};

SteamTradeOffers.prototype.getItemsFromReceipt = function(trade_id, callback) {
    var options = {
        uri: 'https://steamcommunity.com/trade/' + trade_id + '/receipt',
        json: true
    };

    this._request.get(options, function(error, response, body) {
        if (error || response.statusCode != 200) {
            this.emit('debug', 'loading receipt: ' + (error || response.statusCode != 200));
            return callback(error || new Error(response.statusCode));
        }
        if (!body || body.success == false) {
            this.emit('debug', 'loading receipt: invalid response');
            return callback(new Error(403));
        }

        var script = body.match(/(var oItem;[\s\S]*)<\/script>/);
        if (!script) {
            // no session
            callback(new Error('Failed to lookup items in receipt'));
            return;
        }

        var items = [];

        try {
            // prepare to execute the script in the page
            var UserYou;
            function BuildHover(str, item) {
                items.push(item);
            }
            function $() {
                return {
                    show: function() {}
                };
            }

            // evil magic happens here
            eval(script[1]);
        } catch (e) {
            callback(new Error('Failed to lookup items in receipt: exception during eval'));
            return;
        }

        callback(null, items);
    }.bind(this));
};

SteamTradeOffers.prototype.getTradeHoldDuration = function(options, callback) {
  var url = 'https://steamcommunity.com/tradeoffer/' + options.tradeOfferId + '/';

  getHoldDuration.bind(this)(url, callback);
};

SteamTradeOffers.prototype.getHoldDuration = function(options, callback) {
  var query = {
    partner: options.partnerAccountId || toAccountId(options.partnerSteamId)
  };

  if (options.accessToken) {
    query.token = options.accessToken;
  }

  var url = 'https://steamcommunity.com/tradeoffer/new/?' + querystring.stringify(query);

  getHoldDuration.bind(this)(url, callback);
};

SteamTradeOffers.prototype.loadMyInventory = function(options, callback) {
  var query = {};

  if (options.language) {
    query.l = options.language;
  }

  if (options.tradableOnly !== false) {
    query.trading = 1;
  }

  var uri = 'https://steamcommunity.com/my/inventory/json/' + options.appId + '/' + options.contextId + '/?' + querystring.stringify(query);

  this._loadInventory([], uri, { json: true }, options.contextId, null, callback);
};

SteamTradeOffers.prototype.loadPartnerInventory = function(options, callback) {
  var form = {
    sessionid: this.sessionID,
    partner: options.partnerSteamId,
    appid: options.appId,
    contextid: options.contextId
  };

  if (options.language) {
    form.l = options.language;
  }

  var offer = 'new';
  if (options.tradeOfferId) {
    offer = options.tradeOfferId;
  }

  var uri = 'https://steamcommunity.com/tradeoffer/' + offer + '/partnerinventory/?' + querystring.stringify(form);

  this._loadInventory([], uri, {
    json: true,
    headers: {
      referer: 'https://steamcommunity.com/tradeoffer/' + offer + '/?partner=' + toAccountId(options.partnerSteamId)
    }
  }, options.contextId, null, callback);
};

function mergeWithDescriptions(items, descriptions, contextid) {
  return Object.keys(items).map(function(id) {
    var item = items[id];
    var description = descriptions[item.classid + '_' + (item.instanceid || '0')];
    for (var key in description) {
      item[key] = description[key];
    }
    // add contextid because Steam is retarded
    item.contextid = contextid;
    return item;
  });
}

function doAPICall(options) {
  var params = {
    uri: 'https://api.steampowered.com/IEconService/' + options.method + '/?key=' + this.APIKey + ((options.post) ? '' : '&' + querystring.stringify(options.params)),
    json: true,
    method: options.post ? 'POST' : 'GET'
  };

  if (options.post) {
    params.form = options.params;
  }

  request(params, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'doing API call ' + options.method + ': ' + (error || response.statusCode));
      if (typeof options.callback == 'function') {
        options.callback(error || new Error(response.statusCode));
      }
      return;
    }
    if (!body || typeof body != 'object') {
      this.emit('debug', 'doing API call ' + options.method + ': invalid response');
      if (typeof options.callback == 'function') {
        options.callback(new Error('Invalid Response'));
      }
      return;
    }
    if (typeof options.callback == 'function') {
      options.callback(null, body);
    }
  }.bind(this));
}

SteamTradeOffers.prototype.getOffers = function(options, callback) {
  doAPICall.bind(this)({
    method: 'GetTradeOffers/v1',
    params: options,
    callback: function(error, res) {
      if (error) {
        return callback(error);
      }

      if (res.response.trade_offers_received !== undefined) {
        res.response.trade_offers_received = res.response.trade_offers_received.map(function(offer) {
          offer.steamid_other = toSteamId(offer.accountid_other);
          return offer;
        });
      }

      if (res.response.trade_offers_sent !== undefined) {
        res.response.trade_offers_sent = res.response.trade_offers_sent.map(function(offer) {
          offer.steamid_other = toSteamId(offer.accountid_other);
          return offer;
        });
      }

      callback(null, res);
    }
  });
};

SteamTradeOffers.prototype.getOffer = function(options, callback) {
  doAPICall.bind(this)({
    method: 'GetTradeOffer/v1',
    params: options,
    callback: function(error, res) {
      if (error) {
        return callback(error);
      }

      if (res.response.offer !== undefined) {
        res.response.offer.steamid_other = toSteamId(res.response.offer.accountid_other);
      }

      callback(null, res);
    }
  });
};

SteamTradeOffers.prototype.getSummary = function(options, callback) {
  doAPICall.bind(this)({
    method: 'GetTradeOffersSummary/v1',
    params: options,
    callback: callback
  });
};

SteamTradeOffers.prototype.declineOffer = function(options, callback) {
  doAPICall.bind(this)({method: 'DeclineTradeOffer/v1', params: {tradeofferid: options.tradeOfferId}, post: true, callback: callback});
};

SteamTradeOffers.prototype.cancelOffer = function(options, callback) {
  doAPICall.bind(this)({method: 'CancelTradeOffer/v1', params: {tradeofferid: options.tradeOfferId}, post: true, callback: callback});
};

SteamTradeOffers.prototype.acceptOffer = function(options, callback) {
  if (options.tradeOfferId === undefined) {
    if (typeof callback == 'function') {
      callback(new Error('No options'));
    }
    return;
  }

  this._request.post({
    uri: 'https://steamcommunity.com/tradeoffer/' + options.tradeOfferId + '/accept',
    headers: {
      referer: 'https://steamcommunity.com/tradeoffer/' + options.tradeOfferId + '/'
    },
    json: true,
    form: {
      sessionid: this.sessionID,
      serverid: 1,
      tradeofferid: options.tradeOfferId
    }
  }, function(error, response, body) {
    if (error) {
      this.emit('debug', 'accepting offer: ' + error);
      if (typeof callback == 'function') {
        callback(error);
      }
      return;
    }
    if (body && body.strError) {
      this.emit('debug', 'accepting offer: ' + body.strError);
      if (typeof callback == 'function') {
        callback(new Error(body.strError));
      }
      return;
    }
    if (response.statusCode != 200) {
      this.emit('debug', 'accepting offer: ' + response.statusCode);
      if (typeof callback == 'function') {
        callback(new Error(response.statusCode));
      }
      return;
    }

    if (typeof callback == 'function') {
      callback(null, body);
    }
  }.bind(this));
};

function toSteamId(accountId) {
  return new Long(parseInt(accountId, 10), 0x1100001).toString();
}

function toAccountId(steamId) {
  return Long.fromString(steamId).toInt().toString();
}

SteamTradeOffers.prototype.makeOffer = function(options, callback) {
  var tradeoffer = {
    newversion: true,
    version: 2,
    me: { assets: options.itemsFromMe, currency: [], ready: false },
    them: { assets: options.itemsFromThem, currency: [], ready: false }
  };

  var formFields = {
    serverid: 1,
    sessionid: this.sessionID,
    partner: options.partnerSteamId || toSteamId(options.partnerAccountId),
    tradeoffermessage: options.message || '',
    json_tradeoffer: JSON.stringify(tradeoffer)
  };

  var query = {
    partner: options.partnerAccountId || toAccountId(options.partnerSteamId)
  };

  if (options.accessToken !== undefined) {
    formFields.trade_offer_create_params = JSON.stringify({ trade_offer_access_token: options.accessToken });
    query.token = options.accessToken;
  }
  
  var referer;
  if (options.counteredTradeOffer !== undefined) {
    formFields.tradeofferid_countered = options.counteredTradeOffer;
    referer = 'https://steamcommunity.com/tradeoffer/' + options.counteredTradeOffer + '/';
  } else {
    referer = 'https://steamcommunity.com/tradeoffer/new/?' + querystring.stringify(query);
  }

  this._request.post({
    uri: 'https://steamcommunity.com/tradeoffer/new/send',
    headers: {
      referer: referer
    },
    json: true,
    form: formFields
  }, function(error, response, body) {
    if (error) {
      this.emit('debug', 'making an offer: ' + error);
      if (typeof callback == 'function') {
        callback(error);
      }
      return;
    }
    if (body && body.strError) {
      this.emit('debug', 'making an offer: ' + body.strError);
      if (typeof callback == 'function') {
        callback(new Error(body.strError));
      }
      return;
    }
    if (response.statusCode != 200) {
      this.emit('debug', 'making an offer: ' + response.statusCode);
      if (typeof callback == 'function') {
        callback(new Error(response.statusCode));
      }
      return;
    }

    if (typeof callback == 'function') {
      callback(null, body);
    }
  }.bind(this));
};

function getHoldDuration (url, callback) {
  this._request.get({
    uri: url
  }, function(error, response, body) {
    if (error || response.statusCode !== 200) {
      this.emit('debug', 'retrieving hold duration: ' + (error || response.statusCode));
      return callback(error || new Error(response.statusCode));
    }
    if (!body) {
      this.emit('debug', 'retrieving hold duration: invalid response');
      return callback(new Error('Invalid Response'));
    }

    var $ = cheerio.load(body);
    var scriptToExec = '';
    var status = $('script').get().some(function (script) {
      if (!script.children[0]) {
        return false;
      }
      var text = script.children[0].data;
      if (/var g_daysMyEscrow/.test(text)) {
        scriptToExec = text;
        return true;
      }
      return false;
    });

    if (!status) {
      this.emit('debug', 'retrieving hold duration: can\'t get hold duration');
      return callback(new Error('Can\'t get hold duration'));
    }

    var sandbox = {
      data: {}
    };

    // prepare to execute the script in new context
    var code = scriptToExec +
        'data.my = g_daysMyEscrow;' +
        'data.their = g_daysTheirEscrow;';

    vm.runInNewContext(code, sandbox);

    callback(null, sandbox.data);
  }.bind(this));
}