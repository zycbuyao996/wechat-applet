// pages/school/school.js
Page({

  /**
   * 页面的初始数据
   */
  data: {
    mark:[],
    subject:[]

  },
  search: function(e){
    var that=this
    console.log(e)
    wx.cloud.callFunction({
      name:"mysql2",
      data:{
        schoolname:e.detail.value
      },
      success(rew){
        console.log("请求成功",rew);
        console.log(rew.result)
        that.setData({
          mark:rew.result
        })
      },
      fail(rew){
        console.log("请求失败",rew)
      }

    })
    wx.cloud.callFunction({
      name:"mysql3",
      data:{
        schoolname:e.detail.value
      },
      success(res){
        console.log("请求成功",res);
        console.log(res.result);
        var subjectlist=res.result;
        subjectlist.sort(that.compare("subjectmark"));
        that.setData({
          subject:subjectlist

        })
      },
      fail(res){
        console.log("请求失败",res)
      }
    })
  },
  compare: function (property) {
    return function (a, b) {
      var value1 = a[property];
      var value2 = b[property];
      return value1 - value2;
    }
 
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {

  }
})