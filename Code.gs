/**
 * Personalized Batch Mailer
 * Bound to the "Personalized Batch Mailer Request" Google Form.
 * Runs as julienne@myadventuregroup.com.au (the form owner) so it can
 * read her Gmail inbox and send mail as her.
 *
 * Setup (one-time, after pasting this file into the Form's Apps Script project):
 *  1. Project Settings > Script properties, add:
 *       SUPABASE_URL              = https://aivitcomiywiysrfwqxt.supabase.co
 *       SUPABASE_SERVICE_ROLE_KEY = <service role key, from Supabase dashboard Settings > API>
 *  2. Triggers (clock icon) > Add Trigger:
 *       Function: onFormSubmit | Event source: From form | Event type: On form submit
 *  3. Run any function once manually to trigger the OAuth consent screen
 *     (needs Gmail read/send + external URL fetch scopes), authorize as julienne.
 *
 * Form item titles are matched by PREFIX (case-insensitive, trimmed), not exact equality —
 * so appending extra instructions/punctuation to a question's title in the Form editor is safe
 * as long as it still starts with the text below.
 */
var FORM_TITLES = {
  REQUESTER: 'requester email address',
  NOTIFY: 'other emails to notify',
  SHEET_URL: 'google sheet link',
  SUBJECT: 'subject of the email',
  SENT_DATE: 'date the email was sent',
  MAPPING: 'placeholder to column mapping',
};

var SUPABASE_TABLE = 'personalized_batch_mailer_requests';
// Apps Script's default UrlFetchApp User-Agent starts with "Mozilla/5.0", which trips Supabase's
// "secret key blocked in browser" safety check. Override it so Supabase sees this as a server call.
var SERVER_USER_AGENT = 'PersonalizedBatchMailer-AppsScript/1.0';
var SOURCE_MAILBOX_TIMEZONE = 'Asia/Manila';

function onFormSubmit(e) {
  var answers = readFormAnswers_(e);
  var supabaseRowId = null;

  try {
    var parsed = parseAndValidateAnswers_(answers);
    supabaseRowId = supabaseInsertRequest_(answers, parsed);

    var sourceMessage = findSourceEmail_(parsed.subject, parsed.sentDatePh);
    var sheetData = readSheet_(parsed.sheetUrl);
    validateMappingColumns_(parsed.mapping, sheetData.headers);

    var sendResult = sendPersonalizedEmails_(
      sourceMessage,
      parsed.subject,
      sheetData,
      parsed.mapping
    );

    sendCompletionEmail_(parsed.requesterEmail, parsed.notifyEmails, parsed.subject, sendResult, null);

    supabaseUpdateRequest_(supabaseRowId, {
      status: 'processed',
      total_recipients: sendResult.total,
      sent_count: sendResult.sent,
      skipped_count: sendResult.skipped,
      processed_at: new Date().toISOString(),
    });
  } catch (err) {
    var message = err && err.message ? err.message : String(err);
    Logger.log('Batch mailer failed: ' + message);

    if (supabaseRowId) {
      supabaseUpdateRequest_(supabaseRowId, {
        status: 'error',
        error_message: message,
        processed_at: new Date().toISOString(),
      });
    }

    var requesterEmail = getAnswerByTitlePrefix_(answers, FORM_TITLES.REQUESTER);
    if (requesterEmail) {
      var notifyList = splitEmailList_(getAnswerByTitlePrefix_(answers, FORM_TITLES.NOTIFY));
      var subjectForError = getAnswerByTitlePrefix_(answers, FORM_TITLES.SUBJECT);
      sendCompletionEmail_(requesterEmail, notifyList, subjectForError, null, message);
    }
  }
}

// ---------- Form parsing ----------

function readFormAnswers_(e) {
  if (!e || !e.response) {
    throw new Error(
      'onFormSubmit received no form-submission event. Do not run this function manually from the ' +
      'editor — it only works when fired by an installable "On form submit" trigger from a real ' +
      'form submission. Check Triggers (clock icon) for a trigger on onFormSubmit / From form / On form submit.'
    );
  }
  var answers = [];
  var items = e.response.getItemResponses();
  for (var i = 0; i < items.length; i++) {
    answers.push({ title: items[i].getItem().getTitle(), response: items[i].getResponse() });
  }
  return answers;
}

function getAnswerByTitlePrefix_(answers, expectedPrefixLowercase) {
  for (var i = 0; i < answers.length; i++) {
    var title = String(answers[i].title || '').trim().toLowerCase();
    if (title.indexOf(expectedPrefixLowercase) === 0) return answers[i].response;
  }
  return undefined;
}

function parseAndValidateAnswers_(answers) {
  var requesterEmail = (getAnswerByTitlePrefix_(answers, FORM_TITLES.REQUESTER) || '').trim();
  var notifyEmails = splitEmailList_(getAnswerByTitlePrefix_(answers, FORM_TITLES.NOTIFY));
  var sheetUrl = (getAnswerByTitlePrefix_(answers, FORM_TITLES.SHEET_URL) || '').trim();
  var subject = (getAnswerByTitlePrefix_(answers, FORM_TITLES.SUBJECT) || '').trim();
  var sentDateRaw = getAnswerByTitlePrefix_(answers, FORM_TITLES.SENT_DATE);
  var mappingRaw = getAnswerByTitlePrefix_(answers, FORM_TITLES.MAPPING) || '';

  if (!isValidEmail_(requesterEmail)) {
    throw new Error('Requester email address is missing or invalid: "' + requesterEmail + '"');
  }
  if (!sheetUrl || !extractSheetId_(sheetUrl)) {
    throw new Error('Could not find a Google Sheet ID in the provided link: "' + sheetUrl + '"');
  }
  if (!subject) {
    throw new Error('Email subject is required.');
  }
  if (!sentDateRaw) {
    throw new Error('Date the email was sent is required.');
  }

  var mapping = parsePlaceholderMapping_(mappingRaw);
  if (Object.keys(mapping).length === 0) {
    throw new Error(
      'Placeholder mapping is empty or not in the expected "{{placeholder}} = Column Name" format, one per line.'
    );
  }

  return {
    requesterEmail: requesterEmail,
    notifyEmails: notifyEmails,
    sheetUrl: sheetUrl,
    subject: subject,
    sentDatePh: parseFormDate_(sentDateRaw),
    mapping: mapping,
    mappingRaw: mappingRaw,
  };
}

function splitEmailList_(raw) {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0 && isValidEmail_(s); });
}

function isValidEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function parseFormDate_(raw) {
  // Google Forms Date items answer with e.g. "2026-08-21"
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) throw new Error('Unrecognized date format from form: "' + raw + '"');
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parsePlaceholderMapping_(raw) {
  var mapping = {};
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    var placeholder = line.substring(0, eqIndex).trim();
    var column = line.substring(eqIndex + 1).trim();
    if (!placeholder || !column) continue;
    mapping[placeholder] = column;
  }
  return mapping;
}

function extractSheetId_(url) {
  var m = /\/d\/([a-zA-Z0-9-_]+)/.exec(url);
  return m ? m[1] : null;
}

// ---------- Gmail: locate the source template email ----------

function findSourceEmail_(subject, sentDatePh) {
  var centerUtc = new Date(Date.UTC(sentDatePh.year, sentDatePh.month - 1, sentDatePh.day));
  var afterDate = new Date(centerUtc.getTime() - 2 * 24 * 60 * 60 * 1000);
  var beforeDate = new Date(centerUtc.getTime() + 3 * 24 * 60 * 60 * 1000);

  var query =
    'subject:"' + subject.replace(/"/g, '\\"') + '" ' +
    'to:me ' +
    'after:' + Utilities.formatDate(afterDate, 'UTC', 'yyyy/MM/dd') + ' ' +
    'before:' + Utilities.formatDate(beforeDate, 'UTC', 'yyyy/MM/dd');

  var threads = GmailApp.search(query, 0, 20);
  var wantedDateStr = sentDatePh.year + '-' + pad2_(sentDatePh.month) + '-' + pad2_(sentDatePh.day);

  var matches = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (msg.getSubject().trim().toLowerCase() !== subject.trim().toLowerCase()) continue;
      var msgDateStr = Utilities.formatDate(msg.getDate(), SOURCE_MAILBOX_TIMEZONE, 'yyyy-MM-dd');
      if (msgDateStr === wantedDateStr) matches.push(msg);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      'No email found in julienne@myadventuregroup.com.au\'s inbox with subject "' + subject +
      '" received on ' + wantedDateStr + ' (Philippine time).'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      'Found ' + matches.length + ' emails matching subject "' + subject + '" on ' + wantedDateStr +
      ' (Philippine time) — cannot tell which one to use. Please make the subject unique or resubmit with a more specific subject.'
    );
  }
  return matches[0];
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

// ---------- Sheet reading ----------

function readSheet_(sheetUrl) {
  var sheetId = extractSheetId_(sheetUrl);
  var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    throw new Error('The Google Sheet has no data rows below the header row.');
  }
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = values.slice(1);
  return { headers: headers, rows: rows };
}

function validateMappingColumns_(mapping, headers) {
  var missing = [];
  Object.keys(mapping).forEach(function (placeholder) {
    var column = mapping[placeholder];
    if (headers.indexOf(column) === -1) missing.push(column);
  });
  if (missing.length > 0) {
    throw new Error(
      'These columns from the placeholder mapping were not found in the sheet header row: ' +
      missing.join(', ') + '. Sheet headers found: ' + headers.join(', ')
    );
  }
}

// ---------- Sending ----------

function sendPersonalizedEmails_(sourceMessage, subject, sheetData, mapping) {
  var templateHtml = sourceMessage.getBody();
  var attachments = sourceMessage.getAttachments({ includeInlineImages: false, includeAttachments: true });
  var headers = sheetData.headers;
  var rows = sheetData.rows;

  var dataRows = rows.filter(function (row) { return isValidEmail_(String(row[0]).trim()); });
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < dataRows.length) {
    throw new Error(
      'Not enough Gmail sending quota left today (' + quota + ' remaining, ' +
      dataRows.length + ' recipients needed). Try again tomorrow or split the list.'
    );
  }

  var sent = 0;
  var skipped = 0;
  var failures = [];

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var recipient = String(row[0]).trim();
    if (!isValidEmail_(recipient)) {
      skipped++;
      continue;
    }

    var personalizedHtml = templateHtml;
    Object.keys(mapping).forEach(function (placeholder) {
      var column = mapping[placeholder];
      var colIndex = headers.indexOf(column);
      var value = colIndex >= 0 && row[colIndex] !== undefined ? String(row[colIndex]) : '';
      personalizedHtml = personalizedHtml.split(placeholder).join(value);
    });

    try {
      GmailApp.sendEmail(recipient, subject, stripHtml_(personalizedHtml), {
        htmlBody: personalizedHtml,
        attachments: attachments,
      });
      sent++;
    } catch (sendErr) {
      failures.push(recipient + ': ' + sendErr.message);
      skipped++;
    }
  }

  return { total: dataRows.length, sent: sent, skipped: skipped, failures: failures };
}

function stripHtml_(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sendCompletionEmail_(requesterEmail, notifyEmails, subject, sendResult, errorMessage) {
  var recipients = [requesterEmail].concat(notifyEmails || []).filter(function (v, i, arr) {
    return v && arr.indexOf(v) === i;
  });
  if (recipients.length === 0) return;

  var body;
  var mailSubject;
  if (errorMessage) {
    mailSubject = 'Batch mailer FAILED: ' + subject;
    body = 'The personalized batch mailer request for subject "' + subject + '" failed:\n\n' + errorMessage;
  } else {
    mailSubject = 'Batch mailer complete: ' + subject;
    body =
      'The personalized batch mailer request for subject "' + subject + '" has finished.\n\n' +
      'Sent: ' + sendResult.sent + '\n' +
      'Skipped/failed: ' + sendResult.skipped + '\n' +
      'Total rows processed: ' + sendResult.total +
      (sendResult.failures.length
        ? '\n\nFailures:\n' + sendResult.failures.join('\n')
        : '');
  }

  MailApp.sendEmail(recipients.join(','), mailSubject, body);
}

// ---------- Supabase logging ----------

function supabaseConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL');
  var key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY script properties are not set.');
  }
  return { url: url, key: key };
}

function supabaseInsertRequest_(answers, parsed) {
  var cfg = supabaseConfig_();
  var payload = {
    requester_email: parsed.requesterEmail,
    notify_emails: parsed.notifyEmails,
    sheet_url: parsed.sheetUrl,
    email_subject: parsed.subject,
    sent_date_ph:
      parsed.sentDatePh.year + '-' + pad2_(parsed.sentDatePh.month) + '-' + pad2_(parsed.sentDatePh.day),
    placeholder_mapping_raw: parsed.mappingRaw,
    status: 'processing',
  };

  var response = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + SUPABASE_TABLE, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=representation',
      'User-Agent': SERVER_USER_AGENT,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 300) {
    throw new Error('Supabase insert failed: ' + response.getContentText());
  }
  var rows = JSON.parse(response.getContentText());
  return rows[0].id;
}

function supabaseUpdateRequest_(rowId, fields) {
  var cfg = supabaseConfig_();
  var response = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/' + SUPABASE_TABLE + '?id=eq.' + encodeURIComponent(rowId),
    {
      method: 'patch',
      contentType: 'application/json',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Prefer: 'return=minimal',
        'User-Agent': SERVER_USER_AGENT,
      },
      payload: JSON.stringify(fields),
      muteHttpExceptions: true,
    }
  );
  if (response.getResponseCode() >= 300) {
    Logger.log('Supabase update failed: ' + response.getContentText());
  }
}
