const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})
const mysql = require('mysql2/promise');
exports.main = async (event, context) => {
  try {
    const connection = await mysql.createConnection({
      host: "bj-cdb-oailqydm.sql.tencentcdb.com", //外网ip地址
      port:"60681",
      user: "root",  //数据库的用户名
      password: "zyc19981214", //数据库密码
      database: "test",  //数据库名称

    })
    let schoolname=event.schoolname;
    const [rows] = await connection.query(
      "select `mark` from `aa学校分数线` where school='"+schoolname+"' limit 0,1"//limit 0,1//只返回第一条符合条件的数据
    );

    connection.end(function(err) {  //注意要断开连接，不然尽管获取到了数据，云函数还是会报超时错误
      console.log('断开连接')
   });
    console.log(rows)
    return rows
  } catch (err) {
    console.log("连接错误", err)
    return err
  }
}