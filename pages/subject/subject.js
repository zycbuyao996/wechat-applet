// pages/subject/subject.js
Page({

  /**
   * 页面的初始数据
   */
  data: {
    schoolname:null,
    subjectlist:[],
    subjectlistall:[]
  },
  compare: function (property) {
    return function (a, b) {
      var value1 = a[property];
      var value2 = b[property];
      return value1 - value2;
    }
 
  },//排序函数
  


  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    const app =getApp();
    console.log(app.globalData)
    var that=this
    var subjectlist1=app.globalData.checkedList
    var name=options.schoolname;
    var subjectlistall=JSON.parse(options.subjectall)
    subjectlistall.sort(that.compare("subjectmark"));//按专业分数线进行排序,subjeclistall必须是json对象
    this.setData({
      schoolname:name,
      subjectlist:subjectlist1,
      subjectlistall:subjectlistall
    })
    wx.setNavigationBarTitle({
      title: this.data.schoolname
   })//动态设置页面标题

  }
})