import getRethinkDB from "../../config/db.js";
import r from "rethinkdb";
import ioEmmit from "../../../app.js";

import meetingService from "../meetings/services.js";
import channelService from "../channels/services.js";
import notificationsService from "../notifications/services.js";
import memberService from "../member/services.js";
import sendMessageRabbit from "../../rabbitmq/send.js";
import getConnectionMySql from "../../config/mysql.js";
import botService from "../bot/services.js"

const service = {};

export const url_taskMap = {};

service.getByChannel = async (id_channel) => {
  const conn = await getRethinkDB();
  return new Promise((resolve, reject) => {
    r.table("messages")
      .filter({ id_channel: id_channel })
      .orderBy(r.asc("create_at"))
      .run(conn, (err, cursor) => {
        if (err) reject({ error: err });
        cursor.toArray((err, result) => {
          if (err) reject({ error: err });
          resolve({ data: result });
        });
      });
  });
};

service.getMessages = async (filter) => {
  const conn = await getRethinkDB();
  return new Promise((resolve, reject) => {
    r.table("messages")
      .filter(filter)
      .orderBy(r.desc("create_at"))
      .run(conn, (err, cursor) => {
        if (err) reject({ error: err });
        cursor.toArray((err, result) => {
          if (err) reject({ error: err });
          resolve(result);
        });
      });
  });
};

service.getMessagesLimit = async (filter, limit, page) => {
  const conn = await getRethinkDB();

  const i = page * limit;
  const j = limit * (page + 1);

  return new Promise((resolve, reject) => {
    r.table("messages")
      .filter(filter)
      .orderBy(r.desc("create_at"))
      .slice(i, j)
      .run(conn, (err, cursor) => {
        if (err) reject({ error: err });
        else
          cursor.toArray((err, result) => {
            if (err) reject({ error: err });
            resolve(result);
          });
      });
  });
};

service.getMessagesPaginate = async (filter, req, limit, page) => {
  return new Promise(async (resolve, reject) => {
    const [result, itemCount] = await Promise.all([
      service
        .getMessagesLimit(filter, limit, page)
        .then((result) => {
          return result;
        })
        .catch((err) => {
          reject(err);
        }),
      service
        .countMessages(filter)
        .then((result) => {
          return result;
        })
        .catch((err) => {
          reject(err);
        }),
    ]);

    const pageCount = Math.ceil(itemCount["data"] / limit);

    resolve({
      data: result,
      itemCount: itemCount["data"],
      limit: limit,
      page: page,
      pageCount,
      has_more: page < pageCount,
    });
  });
};

service.addMessages = async (message, file) => {
  return new Promise((resolve, reject) => {
    meetingService
      .getMeetingActiveByChannel(message.id_channel)
      .then((result) => {
        if (result.length === 0) {
          meetingService
            .createMeeting(message.id_channel)
            .then((result) => {
              message.id_meet = result.id;
              service
                .insertMessage(message, file)
                .then((result) => {
                  resolve(result);
                })
                .catch((err) => {
                  reject(err);
                });
            })
            .catch((err) => {
              reject(err);
            });
        } else {
          if (result[0].status === "waiting") {
            // ioEmmit({ to: message.id_channel, key: "close_meeting" });
            meetingService.closeMeeting(result[0].id, message.id_channel);
          }
          const timeout = setTimeout(() => {
            // ioEmmit({ to: message.id_channel, key: "close_meeting" });

            meetingService.closeMeeting(result[0].id, message.id_channel);
          }, 3600000);
          if (url_taskMap[result[0].id]) {
            clearTimeout(url_taskMap[result[0].id]);
          }
          url_taskMap[result[0].id] = timeout;

          message.id_meet = result[0].id;
          service
            .insertMessage(message, file)
            .then((result) => {
              resolve(result);
            })
            .catch((err) => {
              reject(err);
            });
        }
      })
      .catch((err) => {
        reject(err);
      });
  });
};

service.insertMessage = async (message, file) => {
  const conn = await getRethinkDB();

  return new Promise((resolve, reject) => {
    try {
      if (message.type === "text" || message.type === "meet") {
        r.table("messages")
          .insert(message)
          .run(conn, (err, res) => {
            if (err) reject({ error: 500 });
            message.id_rethink = res.generated_keys[0];
            console.log("messages");

            sendMessageRabbit({
              msg: message,
              flag: "insert_messages",
            });
            let messageStatus = {
              id_message: res.generated_keys[0],
              status: "sent",
            };
            service.messageStatus(messageStatus);
            resolve({ status: 200, message: message });

            // if (message.author_type != "back") {
            //   service.messageNotification(message);
            // }

            channelService.channelById(message.id_channel)
              .then((res) => {
                console.log(res);
                if(res[0].id_user == 11111111 && message.author != "bot"){
                  botService.getPing();
                  setTimeout(botService.postMessage, 1000, message, message.id_channel);
                } else if (message.author_type != "back") {
                  service.messageNotification(message);
                }
              })
              .catch((err) => {
                console.log(err);
              })
          });
      } else {
        message.url_file = file.location;
        message.name_file = file.originalname;
        message.size_file = file.size;
        r.table("messages")
          .insert(message)
          .run(conn, (err, res) => {
            if (err) console.log(err);
            message.id_rethink = res.generated_keys[0];
            console.log("messages");

            sendMessageRabbit({
              msg: message,
              flag: "insert_messages",
            });
            let messageStatus = {
              id_message: res.generated_keys[0],
              status: "sent",
            };
            service.messageStatus(messageStatus);
            resolve({ status: 200, message: message });

            service.messageNotification(message);
          });
      }
    } catch (e) {
      resolve({ error: e, status: 500 });
    }
  });
};

service.messageNotification = (message) => {
  channelService
    .channelById(message.id_channel)
    .then((result) => {
      if (result.length > 0) {
        if (message.author_type === "member") {
          notificationsService.sendNotification(
            {
              id_user: result[0].id_user,
            },
            message,
            result[0].brand ?? 1
          );
        } else {
          memberService
            .getMemberByRethink(result[0].id_member)
            .then((result) => {
              notificationsService.sendNotification(
                {
                  id_member: result[0].id_member,
                },
                message,
                result[0].brand ?? 1
              );
            })
            .catch((err) => {
              console.log(err);
            });
        }
      } else {
        // reject("channel not found");
        console.log("channel not found");
      }
    })
    .catch((err) => {
      // reject(err);
      console.log(err);
    });
};

service.messageStatus = async (status) => {
  const conn = await getRethinkDB();

  return new Promise((resolve, reject) => {
    r.table("message_status")
      .insert(status)
      .run(conn, (err, res) => {
        if (err) console.log(err);
        resolve("change status successfully");
      });
  });
};

service.createChanges = async (id_channel) => {
  const conn = await getRethinkDB();

  r.table("messages")
    .filter({ id_channel: id_channel })
    .changes()
    .run(conn, (err, cursorChanges) => {
      if (err) console.error(err);
      cursorChanges.each((err, result) => {
        console.log(result.new_val);
        ioEmmit({
          key: "receive_message",
          data: {
            ...result.new_val,
            status: "sent",
          },
          to: id_channel,
        });
      });
    });
};

service.countMessages = async (filter) => {
  const conn = await getRethinkDB();

  return new Promise((resolve, reject) => {
    r.table("messages")
      .filter(filter)
      .count()
      .run(conn, (err, result) => {
        if (err) reject(err);
        resolve({ data: result });
      });
  });
};

service.addMessagesSql = (member) =>{ 
  const connMySql = getConnectionMySql();
  const query = () => {
    return new Promise((res, rej) => {
      connMySql.query(
        `INSERT INTO messages (author, author_name, author_type, content, create_at, id_channel, id_meet, id_rethink, type, url_file, name_file, size_file) VALUES ('${member.author}','${member.author_name}','${member.author_type}',"${member.content}",'${member.create_at}','${member.id_channel}','${member.id_meet}','${member.id_rethink}','${member.type}','${member.url_file ?? null}','${member.name_file ?? null}','${member.size_file ?? null}')`,
        (err, result) => {
          if (err) rej(err);
          console.log(result);
          res("execute query successfully")
        }
      );
    });
  };
  query()
  .then((result) => {
    console.log(result);
  })
  .catch((err) => {
    console.log(err);
  });
}
export default service;
