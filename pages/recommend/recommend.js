// pages/recommend/recommend.js
Page({

  /**
   * 页面的初始数据
   */
  data: {
  schoollist:[],
  schoolname:null

  },
  subject:function(e){
    wx.cloud.callFunction({
      name:"mysql3",
      data:{
        schoolname:e.currentTarget.dataset.school
      },
      success(res){
        console.log("请求成功",res);
        var jsonData = JSON.stringify(res.result);
        wx.navigateTo({
          url: '/pages/subject/subject?schoolname='+e.currentTarget.dataset.school+'&subjectall='+jsonData,//携多参数跳转页面
        })
      },
      fail(res){
        console.log("请求失败",res)
      }
    })


  },//view点击跳转

  compare: function (property) {
    return function (a, b) {
      var value1 = a[property];
      var value2 = b[property];
      return value2 - value1;
    }
 
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    var list = JSON.parse(options.schoollist);
    var that=this;
    list.sort(that.compare("mark"));//调用compare函数对list进行排序
    console.log(list)
    this.setData({
      schoollist:list//JSON.stringify(list)
    })

  

  }

})